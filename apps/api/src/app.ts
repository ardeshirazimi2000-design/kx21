import crypto from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate } from './auth/middleware.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { agendaRouter } from './routes/agenda.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter, filesRouter } from './routes/documents.js';
import { meetingsRouter } from './routes/meetings.js';
import { minutesRouter } from './routes/minutes.js';
import { reportsRouter } from './routes/reports.js';
import { resolutionsRouter } from './routes/resolutions.js';
import { rolesRouter } from './routes/roles.js';
import { structureRouter } from './routes/structure.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const openapiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi.yaml');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // On a plain-HTTP trial install (e.g. http://server:8000) these would break loading.
      hsts: config.publicHttps,
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.publicHttps ? [] : null } },
    }),
  );
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  // Request id + access log (path only: query strings may carry signed tokens).
  app.use((req, res, next) => {
    const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? crypto.randomUUID();
    res.setHeader('x-request-id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        { reqId: id, method: req.method, path: req.path, status: res.statusCode, ms: Number(process.hrtime.bigint() - start) / 1e6, user: req.user?.id },
        'request',
      );
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.get('/api/openapi.yaml', (_req, res) => {
    res.type('text/yaml').send(readFileSync(openapiPath, 'utf8'));
  });

  app.use('/api/auth', authRouter);
  app.use('/api', filesRouter);

  const api = express.Router();
  api.use(authenticate);
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: config.isTest ? 100000 : 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '0.0.0.0'),
    }),
  );
  api.use(structureRouter);
  api.use(meetingsRouter);
  api.use(agendaRouter);
  api.use(minutesRouter);
  api.use(resolutionsRouter);
  api.use(documentsRouter);
  api.use(reportsRouter);
  api.use(rolesRouter);
  app.use('/api', api);

  // Single-port mode: serve the built web app and fall back to index.html for client routes.
  if (config.webDistDir && existsSync(path.join(config.webDistDir, 'index.html'))) {
    const dir = path.resolve(config.webDistDir);
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
    logger.info({ dir }, 'serving web app');
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'مسیر یافت نشد' } });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { code: 'file_too_large', message: `حداکثر حجم فایل ${config.maxUploadMb} مگابایت است` } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_json', message: 'JSON نامعتبر است' } });
      return;
    }
    if (err?.name === 'ZodError') {
      res.status(400).json({ error: { code: 'bad_request', message: 'پارامتر نامعتبر است', details: err.issues } });
      return;
    }
    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'خطای داخلی سرور' } });
  });

  return app;
}
