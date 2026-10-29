// Composition root: wires the five MVP services (Auth, Patient[+Doctor], Appointment[+Notification],
// Consultation[+Prescription], AI Assistant[+Triage]) behind one gateway. Each module owns its
// tables and talks to the others through the domain objects / events defined here, so it can be
// split into its own deployable later (design doc §1, "5 services in MVP").
import http from 'node:http';
import { tmpdir, availableParallelism } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, RateLimiter, readJson, sendJson, sendError, newTraceId, ApiError } from './lib/http.js';
import { openDb, uuid, nowIso } from './lib/db.js';
import { createModerator } from './lib/moderation.js';
import { createKeyring } from './lib/crypto.js';
import { createPlatform } from './lib/platform.js';
import * as auth from './modules/auth.js';
import * as patient from './modules/patient.js';
import * as appointment from './modules/appointment.js';
import * as consultation from './modules/consultation.js';
import * as aiRoutes from './modules/ai/routes.js';
import * as files from './modules/files.js';
import * as doctors from './modules/doctors.js';
import * as payments from './modules/payments.js';
import * as records from './modules/records.js';
import * as summaries from './modules/summaries.js';
import * as cxr from './modules/cxr.js';
import * as rxTools from './modules/rx/routes.js';
import { createDrugDirectory } from './modules/rx/drug-directory.js';
import * as drugCatalog from './modules/rx/drug-catalog.js';
import * as rxSuggest from './modules/rx/suggest.js';
import * as access from './modules/access.js';
import * as accounting from './modules/accounting.js';
import * as support from './modules/support.js';
import * as contracts from './modules/contracts.js';
import * as magazine from './modules/magazine.js';
import { createMagazinePages } from './modules/magazine-pages.js';
import { createLabOcr } from './modules/ai/lab-ocr.js';
import { createIdentityService } from './modules/identity.js';
import { createAssistant } from './modules/ai/assistant.js';
import { createLlm } from './modules/ai/llm.js';
import { seed, bootstrapProduction } from './seed.js';
import { createSms } from './lib/sms.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };

export function loadConfig(env = process.env) {
  const devMode = env.NODE_ENV !== 'production';
  if (!devMode && !env.MASTER_SECRET) throw new Error('MASTER_SECRET is required in production');
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    trustedProxies: String(env.TRUSTED_PROXIES || '').split(',').map((x) => x.trim()).filter(Boolean),
    dbPath: env.DB_PATH || 'data/telehealth.db',
    masterSecret: env.MASTER_SECRET || 'dev-only-insecure-master-secret',
    defaultTenant: env.DEFAULT_TENANT_ID || '00000000-0000-4000-8000-000000000001',
    devMode,
    // Demo data only in development unless explicitly asked for.
    seed: env.SEED ? env.SEED !== 'false' : env.NODE_ENV !== 'production',
    // Production bootstrap: the real administrator's mobile number (demo accounts are disabled).
    adminPhone: env.ADMIN_PHONE || '',
    adminTakeover: env.ADMIN_TAKEOVER === '1',
    llmBaseUrl: env.LLM_BASE_URL || '',
    llmModel: env.LLM_MODEL || 'llama-3.1-8b-instruct',
    llmApiKey: env.LLM_API_KEY || '',
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS || 8000),
    // Chest X-ray pattern flags (local service from cxr/; research aid for physicians).
    cxrUrl: env.CXR_URL || '',
    // Iranian drug directory (reference for prescribers), e.g. https://api.majidapi.ir/darooyab
    drugApiBase: env.DRUG_API_BASE || '',
    drugApiToken: env.DRUG_API_TOKEN || '',
    livekitUrl: env.LIVEKIT_URL || '',
    // WebRTC: the clinic's TURN relay (coturn, use-auth-secret) and optional extra STUN servers.
    turnUrls: (env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean),
    turnSecret: env.TURN_SECRET || '',
    stunUrls: (env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map((u) => u.trim()).filter(Boolean),
    // Identity (s.api.ir): Shahkar mobile ↔ national-code match; optional identity inquiry URL.
    sapiToken: env.SAPI_TOKEN || '',
    sapiBase: env.SAPI_BASE || 'https://s.api.ir/api/sw1',
    identityInquiryUrl: env.IDENTITY_INQUIRY_URL || '',
    // Uploaded files (encrypted at rest). Defaults next to the database.
    filesDir: env.FILES_DIR || '',
    // Payments (ZarinPal v4). Without a merchant id, development uses a mock gateway.
    zarinpalMerchantId: env.ZARINPAL_MERCHANT_ID || '',
    zarinpalSandbox: env.ZARINPAL_SANDBOX === 'true',
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    // Optional self-hosted vision model for the doctor's AI pre-read of images.
    visionLlmBaseUrl: env.VISION_LLM_BASE_URL || '',
    visionLlmModel: env.VISION_LLM_MODEL || 'qwen2.5-vl-7b-instruct',
    disableSweeper: false,
    // Server processes (one per CPU core, at most 4, in production); WORKERS=1 runs a single process.
    workers: Math.max(1, Number(env.WORKERS) || (env.NODE_ENV === 'production' ? Math.min(availableParallelism(), 4) : 1)),
    // Visit room opens only around the appointment time (production default; ENFORCE_JOIN_WINDOW=false turns it off).
    enforceJoinWindow: env.ENFORCE_JOIN_WINDOW ? env.ENFORCE_JOIN_WINDOW === 'true' : !devMode,
    streamDelayMs: Number(env.STREAM_DELAY_MS ?? 12),
    logNotifications: env.LOG_NOTIFICATIONS !== 'false',
    smsProvider: env.SMS_PROVIDER || '',
    smsApiKey: env.SMS_API_KEY || '',
    smsOtpTemplate: env.SMS_OTP_TEMPLATE || '',
    smsMfaTemplate: env.SMS_MFA_TEMPLATE || '',
    smsTemplateParam: env.SMS_TEMPLATE_PARAM || 'Code',
    smsSender: env.SMS_SENDER || '',
    smsApiirService: env.SMS_APIIR_SERVICE || 'SmsOTP',
    // Origins of the native app WebViews (Capacitor Android / iOS) plus any extra web origins.
    corsOrigins: (env.CORS_ORIGINS || 'https://localhost,capacitor://localhost,http://localhost')
      .split(',').map((o) => o.trim()).filter(Boolean),
  };
}

export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const db = openDb(config.dbPath);
  const keys = createKeyring(config);
  const sms = createSms(config);
  const platform = createPlatform({ db, config, sms });
  const limiter = new RateLimiter(db);
  if (!config.disableSweeper) setInterval(() => { try { limiter.sweepShared(); } catch (e) { console.error('[limits]', e.message); } }, 10 * 60_000).unref();
  // Loopback is always a trusted proxy; TRUSTED_PROXIES adds address prefixes (e.g. the Docker bridge "172.").
  const proxyPrefixes = ['127.', '::ffff:127.', ...(config.trustedProxies ?? []).flatMap((p) => [p, `::ffff:${p}`])];
  const isTrustedProxy = (peer) => peer === '::1' || proxyPrefixes.some((p) => peer.startsWith(p));
  const router = new Router();

  const domain = { sms, access: access.createAccess({ db }) };
  if (!config.filesDir) config.filesDir = config.dbPath === ':memory:' ? join(tmpdir(), `kx21-files-${process.pid}-${Date.now()}`) : join(dirname(config.dbPath), 'files');
  domain.identity = createIdentityService(config);
  domain.files = files.createFilesDomain({ db, keys, config });
  domain.labOcr = createLabOcr();
  domain.drugDirectory = createDrugDirectory({ db, config });
  domain.drugCatalog = drugCatalog.createDrugCatalog({ db });
  domain.magazine = magazine.createMagazineDomain({ db, platform, config, domain });
  domain.patient = patient.createPatientDomain({ db, keys, files: () => domain.files });
  domain.moderate = createModerator({ db, ApiError, uuid, nowIso });
  domain.payments = payments.createPaymentsDomain({ db, platform, config });
  domain.appointment = appointment.createAppointmentDomain({ db, platform, config, patientDomain: domain.patient, payments: domain.payments });
  const deps = { db, keys, platform, config, limiter, domain };

  auth.register(router, deps);
  patient.register(router, deps);
  appointment.register(router, deps);
  consultation.register(router, deps); // also sets domain.prescription
  domain.assistant = createAssistant({ db, platform, domain, config, llm: createLlm(config) });
  aiRoutes.register(router, deps);
  files.register(router, deps);
  doctors.register(router, deps);
  payments.register(router, deps);
  records.register(router, deps);
  summaries.register(router, deps);
  cxr.register(router, deps);
  rxTools.register(router, deps);
  drugCatalog.register(router, deps);
  rxSuggest.register(router, deps);
  access.register(router, deps);
  access.registerActivity(router, deps);
  accounting.register(router, deps);
  support.register(router, deps);
  contracts.register(router, deps);
  magazine.register(router, deps);
  const magPages = createMagazinePages({ db, config, domain, limiter });

  router.get('/healthz', async () => ({ body: { status: 'ok' } }));
  router.get('/v1/config', async () => ({
    body: { dev_mode: config.devMode, sms: sms.enabled, llm: config.llmBaseUrl ? 'self-hosted' : 'template', livekit: !!config.livekitUrl, cxr: !!config.cxrUrl },
  }));

  // In multi-core mode the primary process does this once, before the workers start.
  if (config.bootstrap !== false) {
    if (config.seed) seed({ db, config, domain });
    if (!config.devMode) bootstrapProduction({ db, config });
    domain.magazine.seedDrafts(config.defaultTenant);
  }

  // Static files: an ETag for cheap revalidation (304), long caching for fonts and images, and
  // gzip for text files (kept in memory per file version).
  const LONG_CACHE = /^(fonts|icons|intro|brand|mag-assets)\//;
  const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
  const gzCache = new Map();
  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) return false;
    let st;
    try { st = await stat(full); } catch { return false; } // the app routes by #hash: unknown paths are real 404s
    if (!st.isFile()) return false;
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const ext = extname(full);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag,
      'Cache-Control': LONG_CACHE.test(rel) ? 'public, max-age=604800' : 'no-cache',
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      ...(COMPRESSIBLE.has(ext) ? { Vary: 'Accept-Encoding' } : {}),
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
    let data = await readFile(full);
    if (COMPRESSIBLE.has(ext) && data.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const key = `${full}|${etag}`;
      let gz = gzCache.get(key);
      if (!gz) { gz = gzipSync(data); if (gzCache.size > 200) gzCache.clear(); gzCache.set(key, gz); }
      data = gz;
      headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Cross-origin requests carry only the site origin (the Enamad seal checks it); paths never leave.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data: https://trustseal.enamad.ir https://*.enamad.ir",
  };

  const server = http.createServer(async (req, res) => {
    const traceId = req.headers['x-trace-id']?.toString().slice(0, 64) || newTraceId();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Trace-Id', traceId);
    // The client times visit-room buttons by the server clock (a phone's clock may be off).
    res.setHeader('X-Server-Time', String(Date.now()));
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id, Idempotent-Replayed, X-Server-Time');
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
      // Behind the reverse proxy (local Caddy/nginx, or a Docker proxy on TRUSTED_PROXIES) the client
      // address comes in X-Forwarded-For. The last entry is the one our proxy added; earlier ones are
      // whatever the client sent and could be forged.
      const peer = req.socket.remoteAddress ?? '';
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).at(-1);
      const ip = fwd && isTrustedProxy(peer) ? fwd : peer;
      if (!url.pathname.startsWith('/v1/') && url.pathname !== '/healthz') {
        // Public health-magazine pages, robots.txt and sitemap.xml are rendered on the server.
        if (await magPages.handle(req, res, url, ip)) return;
        if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, url.pathname))) return;
        if (req.method === 'GET' || req.method === 'HEAD') { magPages.notFoundPage(req, res); return; }
        throw new ApiError(404, 'not_found', 'مسیر پیدا نشد');
      }
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
      // A disabled account loses access immediately, not when its token expires; so does a token
      // issued before the account's role was changed (e.g. a patient account made a support agent).
      if (ctx.user) {
        const acc = db.get('SELECT role, disabled_at, deleted_at FROM users WHERE id = ?', ctx.user.sub);
        if (!acc || acc.disabled_at || acc.deleted_at) throw new ApiError(401, 'account_disabled', 'این حساب غیرفعال شده است');
        if (acc.role !== ctx.user.role) throw new ApiError(401, 'role_changed', 'نقش حساب شما تغییر کرده است؛ دوباره وارد شوید');
      }
      if (ctx.user && headerTenant && headerTenant !== ctx.user.tid) throw new ApiError(403, 'tenant_mismatch', 'tenant نامعتبر است');
      if (ctx.user) limiter.hit(`user:${ctx.user.sub}`, 300, 60_000);
      // File uploads stream the raw body to the handler; everything else is JSON.
      const ctype = String(req.headers['content-type'] ?? '');
      ctx.body = /^(image\/|application\/(pdf|octet-stream|vnd\.openxmlformats))/.test(ctype) ? {} : await readJson(req);
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
