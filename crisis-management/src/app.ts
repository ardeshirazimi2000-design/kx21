import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
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
    logger.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'خطای داخلی سامانه' } });
  });

  return app;
}
