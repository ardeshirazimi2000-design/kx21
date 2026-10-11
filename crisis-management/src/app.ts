import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { query } from './db/pool.js';
import { audit } from './lib/audit.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { authenticate, requirePasswordCurrent } from './security/middleware.js';
import { appAuthRouter } from './routes/appAuth.js';
import { consoleAuthRouter } from './routes/consoleAuth.js';
import { apiLimiter } from './routes/limiters.js';
import { meRouter } from './routes/me.js';
import { operationsRouter } from './routes/operations.js';
import { rolesRouter } from './routes/roles.js';
import { securityRouter } from './routes/security.js';
import { usersRouter } from './routes/users.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      strictTransportSecurity: config.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // FTP_TRP.1.3: remote use only over the trusted path (TLS). Behind a proxy set TRUST_PROXY so req.secure is honoured.
  if (config.REQUIRE_HTTPS) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      if (req.method === 'GET' && !req.path.startsWith('/api/')) return void res.redirect(308, `https://${req.hostname}${req.originalUrl}`);
      res.status(403).json({ error: { code: 'https_required', message: 'ارتباط فقط از طریق HTTPS مجاز است' } });
    });
  }

  const origins = config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      if (req.method === 'OPTIONS') return void res.status(204).end();
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', apiLimiter);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // FDP_ACF.1.3: unauthenticated visitors may read public information only — city-wide public alerts.
  app.get('/api/public/alerts', async (_req, res) => {
    res.json(
      await query(
        `SELECT id, title, body, level, published_at FROM alerts
          WHERE district_id IS NULL AND published_at > now() - interval '3 days' ORDER BY published_at DESC LIMIT 20`,
      ),
    );
  });

  // FCS_TLSS_EXT.2.4 / FIA_X509_EXT: optional X.509 client certificates for the console (mutual TLS).
  if (config.TLS_REQUIRE_CLIENT_CERT_CONSOLE) {
    app.use(['/api/console', '/console'], (req, res, next) => {
      const sock = req.socket as TLSSocket;
      if (sock.authorized) return next();
      res.status(403).json({ error: { code: 'client_certificate_required', message: 'ورود به کنسول نیازمند گواهی معتبر کاربر است' } });
    });
  }

  // ── Console (management panel): password + OTP sign-in, full RBAC ──
  app.use('/api/console/auth', consoleAuthRouter);
  const consoleApi = express.Router();
  consoleApi.use(authenticate('console'));
  consoleApi.use('/me', meRouter);
  consoleApi.use(requirePasswordCurrent);
  consoleApi.use('/users', usersRouter);
  consoleApi.use('/roles', rolesRouter);
  consoleApi.use('/security', securityRouter);
  consoleApi.use('/', operationsRouter);
  app.use('/api/console', consoleApi);

  // ── Mobile app: Shahkar + OTP on first sign-in, OTP afterwards ──
  app.use('/api/app/auth', appAuthRouter);
  const appApi = express.Router();
  appApi.use(authenticate('app'));
  appApi.use('/me', meRouter);
  appApi.use('/', operationsRouter);
  app.use('/api/app', appApi);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'مسیر یافت نشد', 'not_found')));

  app.use('/console', express.static(path.join(publicDir, 'console')));
  app.use('/app', express.static(path.join(publicDir, 'app')));
  app.use('/shared', express.static(path.join(publicDir, 'shared')));
  app.get('/', (_req, res) => res.redirect('/console/'));
  // PP policy "proper configuration": no default framework 404 pages revealing the technology.
  app.use((_req, res) => {
    res.status(404).type('text/plain; charset=utf-8').send('یافت نشد');
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.status === 429 && (err.details as { retryAfterSec?: number })?.retryAfterSec) {
        res.setHeader('Retry-After', String((err.details as { retryAfterSec: number }).retryAfterSec));
      }
      return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return void res.status(400).json({ error: { code: 'bad_request', message: 'بدنه درخواست JSON معتبر نیست' } });
    }
    // FPT_FLS.1: fail closed with a generic message (no internals); the reference links the user's report to the log.
    const ref = randomUUID().slice(0, 8);
    logger.error({ err, path: req.path, ref }, 'unhandled error');
    void audit({ action: 'system.error', actorId: req.user?.id ?? null, outcome: 'failure', ip: req.ip, channel: req.user?.channel ?? null, details: { ref, path: req.path, method: req.method } }).catch(() => undefined);
    res.status(500).json({ error: { code: 'internal', message: `خطای داخلی سامانه (کد پیگیری ${ref})` } });
  });

  return app;
}
