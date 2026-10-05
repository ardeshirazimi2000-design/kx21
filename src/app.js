// Composition root: wires the five MVP services (Auth, Patient[+Doctor], Appointment[+Notification],
// Consultation[+Prescription], AI Assistant[+Triage]) behind one gateway. Each module owns its
// tables and talks to the others through the domain objects / events defined here, so it can be
// split into its own deployable later (design doc §1, "5 services in MVP").
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, RateLimiter, readJson, sendJson, sendError, newTraceId, ApiError } from './lib/http.js';
import { openDb } from './lib/db.js';
import { createKeyring } from './lib/crypto.js';
import { createPlatform } from './lib/platform.js';
import * as auth from './modules/auth.js';
import * as patient from './modules/patient.js';
import * as appointment from './modules/appointment.js';
import * as consultation from './modules/consultation.js';
import * as aiRoutes from './modules/ai/routes.js';
import { createAssistant } from './modules/ai/assistant.js';
import { createLlm } from './modules/ai/llm.js';
import { seed } from './seed.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json' };

export function loadConfig(env = process.env) {
  const devMode = env.NODE_ENV !== 'production';
  if (!devMode && !env.MASTER_SECRET) throw new Error('MASTER_SECRET is required in production');
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || 'data/telehealth.db',
    masterSecret: env.MASTER_SECRET || 'dev-only-insecure-master-secret',
    defaultTenant: env.DEFAULT_TENANT_ID || '00000000-0000-4000-8000-000000000001',
    devMode,
    seed: env.SEED !== 'false',
    llmBaseUrl: env.LLM_BASE_URL || '',
    llmModel: env.LLM_MODEL || 'llama-3.1-8b-instruct',
    llmApiKey: env.LLM_API_KEY || '',
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS || 8000),
    livekitUrl: env.LIVEKIT_URL || '',
    // WebRTC: the clinic's TURN relay (coturn, use-auth-secret) and optional extra STUN servers.
    turnUrls: (env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean),
    turnSecret: env.TURN_SECRET || '',
    stunUrls: (env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map((u) => u.trim()).filter(Boolean),
    enforceJoinWindow: env.ENFORCE_JOIN_WINDOW === 'true',
    streamDelayMs: Number(env.STREAM_DELAY_MS ?? 12),
    logNotifications: env.LOG_NOTIFICATIONS !== 'false',
    smsProvider: env.SMS_PROVIDER || '',
    // Origins of the native app WebViews (Capacitor Android / iOS) plus any extra web origins.
    corsOrigins: (env.CORS_ORIGINS || 'https://localhost,capacitor://localhost,http://localhost')
      .split(',').map((o) => o.trim()).filter(Boolean),
  };
}

export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const db = openDb(config.dbPath);
  const keys = createKeyring(config);
  const platform = createPlatform({ db, config });
  const limiter = new RateLimiter();
  const router = new Router();

  const domain = {};
  domain.patient = patient.createPatientDomain({ db, keys });
  domain.appointment = appointment.createAppointmentDomain({ db, platform, patientDomain: domain.patient });
  const deps = { db, keys, platform, config, limiter, domain };

  auth.register(router, deps);
  patient.register(router, deps);
  appointment.register(router, deps);
  consultation.register(router, deps); // also sets domain.prescription
  domain.assistant = createAssistant({ db, platform, domain, config, llm: createLlm(config) });
  aiRoutes.register(router, deps);

  router.get('/healthz', async () => ({ body: { status: 'ok' } }));
  router.get('/v1/config', async () => ({
    body: { dev_mode: config.devMode, llm: config.llmBaseUrl ? 'self-hosted' : 'template', livekit: !!config.livekitUrl },
  }));

  if (config.seed) seed({ db, config, domain });

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) return false;
    try {
      const data = await readFile(full);
      res.writeHead(200, {
        'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
        ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      });
      res.end(data);
      return true;
    } catch {
      if (!extname(rel)) { // SPA fallback
        const data = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
        return true;
      }
      return false;
    }
  }

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
  };

  const server = http.createServer(async (req, res) => {
    const traceId = req.headers['x-trace-id']?.toString().slice(0, 64) || newTraceId();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Trace-Id', traceId);
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id, Idempotent-Replayed');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Tenant-Id, X-Trace-Id',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
    }
    try {
      if (!url.pathname.startsWith('/v1/') && url.pathname !== '/healthz') {
        if (req.method === 'GET' && (await serveStatic(req, res, url.pathname))) return;
        throw new ApiError(404, 'not_found', 'مسیر پیدا نشد');
      }
      const ip = req.socket.remoteAddress;
      limiter.hit(`ip:${ip}`, 600, 60_000);
      const m = router.match(req.method, url.pathname);
      if (!m) throw new ApiError(404, 'not_found', 'مسیر پیدا نشد');
      if (m === 'method') throw new ApiError(405, 'method_not_allowed', 'متد مجاز نیست');

      const headerTenant = req.headers['x-tenant-id']?.toString();
      const ctx = {
        req, res, traceId, ip, params: m.params, query: Object.fromEntries(url.searchParams),
        tenantId: headerTenant || config.defaultTenant, user: null, body: {},
      };
      auth.authenticate(ctx, keys);
      if (ctx.user && headerTenant && headerTenant !== ctx.user.tid) throw new ApiError(403, 'tenant_mismatch', 'tenant نامعتبر است');
      if (ctx.user) limiter.hit(`user:${ctx.user.sub}`, 300, 60_000);
      ctx.body = await readJson(req);
      if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new ApiError(422, 'invalid_json', 'بدنه باید شیء JSON باشد');

      const out = await m.handler(ctx);
      if (out === null || res.headersSent) return;
      if (out.status === 204) { res.writeHead(204); res.end(); return; }
      sendJson(res, out.status || 200, out.body ?? {}, out.headers);
    } catch (err) {
      sendError(res, err, traceId);
    }
  });

  return { server, db, config, domain, platform, close: () => { server.close(); db.close(); } };
}
