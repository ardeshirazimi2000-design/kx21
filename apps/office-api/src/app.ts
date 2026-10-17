import crypto from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate } from './auth/middleware.js';
import { config } from './config.js';
import { pool, query } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { observeRequest, renderMetrics } from './lib/metrics.js';
import { archiveRouter } from './routes/archive.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { integrationPublicRouter, integrationRouter } from './routes/integration.js';
import { lettersRouter, publicLettersRouter } from './routes/letters.js';
import { notificationsRouter } from './routes/notifications.js';
import { orgRouter } from './routes/org.js';
import { reportsRouter } from './routes/reports.js';
import { signaturesRouter } from './routes/signatures.js';
import { workflowsRouter } from './routes/workflows.js';

const openapiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi.yaml');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ hsts: config.publicHttps, contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.publicHttps ? [] : null } } }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));

  // Request id, access log and metrics (route pattern, not the raw path).
  app.use((req, res, next) => {
    const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? crypto.randomUUID();
    res.setHeader('x-request-id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const sec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      observeRequest(req.method, route, res.statusCode, sec);
      logger.info({ reqId: id, method: req.method, path: req.path, status: res.statusCode, ms: sec * 1000, user: req.user?.id }, 'request');
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.get('/metrics', async (_req, res) => {
    const [q] = await query(`SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'failed') AS failed FROM jobs`);
    res.type('text/plain; version=0.0.4').send(renderMetrics({ jobs_queued: q.queued, jobs_failed: q.failed }));
  });
  app.get('/api/openapi.yaml', (_req, res) => {
    res.type('text/yaml').send(readFileSync(openapiPath, 'utf8'));
  });

  // Routes with their own body parsing / authentication (webhook needs the raw body).
  app.use('/api', integrationPublicRouter);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api', publicLettersRouter);

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
  api.use(orgRouter, signaturesRouter, lettersRouter, workflowsRouter, archiveRouter, notificationsRouter, reportsRouter, integrationRouter, auditRouter);
  app.use('/api', api);

  if (config.webDistDir && existsSync(path.join(config.webDistDir, 'index.html'))) {
    const dir = path.resolve(config.webDistDir);
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
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
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', message: 'حجم درخواست بیش از حد مجاز است' } });
      return;
    }
    if (err?.name === 'ZodError') {
      res.status(400).json({ error: { code: 'bad_request', message: 'پارامتر نامعتبر است', details: err.issues } });
      return;
    }
    if (err?.code === '23505') {
      res.status(409).json({ error: { code: 'duplicate', message: 'رکورد تکراری است' } });
      return;
    }
    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'خطای داخلی سرور' } });
  });
  return app;
}
