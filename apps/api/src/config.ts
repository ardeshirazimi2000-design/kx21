import net from 'node:net';
import { sampleSecretProblems } from '@kx/shared';

// Dates in minutes/notifications are rendered in Iran time unless configured otherwise.
process.env.TZ ??= 'Asia/Tehran';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * Which reverse proxies may set X-Forwarded-For / X-Forwarded-Proto (Express `trust proxy`), as in the office API:
 *  a number → that many proxy hops in front (default 1: the web container's nginx);
 *  "", "false", "0" → none; a comma list of addresses, CIDR ranges or loopback / linklocal / uniquelocal → only those.
 * "true" (trust whoever connects) is refused: any client could then choose its own address.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const v = (raw ?? '1').trim();
  if (v === '' || v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true') throw new Error('TRUST_PROXY=true would trust a client-chosen address; give the number of proxies or their addresses');
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    const [addr, bits, extra] = item.split('/');
    const keyword = ['loopback', 'linklocal', 'uniquelocal'].includes(item);
    const family = net.isIP(addr);
    const prefixOk = bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 6 ? 128 : 32));
    if (!keyword && (!family || !prefixOk || extra !== undefined)) throw new Error(`TRUST_PROXY: "${item}" is not an address, a CIDR range or loopback/linklocal/uniquelocal`);
  }
  return items;
}

export const config = {
  isProd,
  isTest: process.env.NODE_ENV === 'test' || !!process.env.VITEST,
  port: Number(env('PORT', '4000')),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /** Users reach the system over HTTPS: HSTS, upgrade-insecure-requests, and sign-in refused over plain HTTP (AFTA 2-9, docs/11-https.md). */
  publicHttps: ['true', '1'].includes((process.env.PUBLIC_HTTPS ?? '').trim().toLowerCase()),
  databaseUrl: env('DATABASE_URL', 'postgres://kx:kx@localhost:5432/kx'),
  jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-only-secret-do-not-use-in-production'),
  accessTokenTtl: env('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtlDays: Number(env('REFRESH_TOKEN_TTL_DAYS', '30')),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()),
  uploadDir: env('UPLOAD_DIR', './uploads'),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '50')),
  /** Meeting recordings (video files of kind «فیلم جلسه») may be larger than other documents. */
  maxRecordingMb: Number(env('MAX_RECORDING_MB', '2048')),
  smsProvider: env('SMS_PROVIDER', 'log'),
  emailProvider: env('EMAIL_PROVIDER', 'log'),
  pushProvider: env('PUSH_PROVIDER', 'log'),
  kavenegarApiKey: process.env.KAVENEGAR_API_KEY,
  kavenegarSender: process.env.KAVENEGAR_SENDER,
  schedulerIntervalSeconds: Number(env('SCHEDULER_INTERVAL_SECONDS', '300')),
  /**
   * National identity inquiry (استعلام هویت): sapi = s.api.ir PersonInfo, mock = development/test data,
   * none = disabled (names typed manually, people stay "unverified").
   */
  identityProvider: (process.env.IDENTITY_PROVIDER ?? (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'mock' : 'none')) as 'sapi' | 'mock' | 'none',
  identityApiUrl: process.env.IDENTITY_API_URL ?? 'https://s.api.ir/api/sw1/PersonInfo',
  identityApiToken: process.env.IDENTITY_API_TOKEN,
  /** Require a verified identity (national code + birth date) for every new person. */
  identityRequired: process.env.IDENTITY_REQUIRED === 'true',
  /** Ask for confirmation before a meeting is scheduled on a holiday. */
  meetingHolidayCheck: process.env.MEETING_HOLIDAY_CHECK !== 'false',
  /** Built web app (apps/web/dist) to serve from this process, for single-port installs. */
  webDistDir: process.env.WEB_DIST_DIR,
  /**
   * Built-in webinar (self-hosted Jitsi Meet with JWT authentication, see deploy/webinar).
   * Enabled when both the public URL and the shared secret are set.
   */
  /** 64 hex chars (AES-256) for secrets at rest; derived from JWT_SECRET when unset. */
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY,
  /** Outbox delivery to integration webhooks (run on a single instance in multi-instance deployments). */
  integrationWorkerEnabled: process.env.INTEGRATION_WORKER_ENABLED !== 'false',
  integrationWorkerIntervalSeconds: Number(process.env.INTEGRATION_WORKER_INTERVAL_SECONDS ?? '5'),
  /**
   * Optional AI engine for finding similar resolutions across networks: any OpenAI-compatible /embeddings API,
   * preferably on the organisation's own server (deploy/ai: Ollama with bge-m3). Unset → text similarity.
   */
  ai: {
    baseUrl: (process.env.AI_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY ?? '',
    embeddingModel: process.env.AI_EMBEDDING_MODEL ?? 'bge-m3',
    /** Minimum cosine similarity (0–1) of two resolutions to be suggested as similar. */
    minScore: Number(process.env.AI_SIMILARITY_MIN ?? 0.6),
    /**
     * Drafting the minutes text and resolutions from a transcript: a chat model on the same Ollama (AI_BASE_URL).
     * Unset → no drafting (the transcript alone is still produced).
     */
    chatModel: process.env.AI_CHAT_MODEL ?? '',
    /** Context window given to the model (tokens); long transcripts are summarised in parts that fit in it. */
    chatContext: Number(process.env.AI_CHAT_CONTEXT ?? 16384),
    chatTimeoutMinutes: Number(process.env.AI_CHAT_TIMEOUT_MINUTES ?? 60),
  },
  /**
   * Speech-to-text of meeting recordings on the organisation's own server: any OpenAI-compatible
   * /audio/transcriptions service, e.g. faster-whisper (speaches) or whisper.cpp server (deploy/ai/README-stt.md).
   */
  stt: {
    baseUrl: (process.env.STT_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.STT_API_KEY ?? '',
    model: process.env.STT_MODEL ?? 'whisper-1',
    language: process.env.STT_LANGUAGE ?? 'fa',
    timeoutMinutes: Number(process.env.STT_TIMEOUT_MINUTES ?? 240),
  },
  transcriptWorkerEnabled: process.env.TRANSCRIPT_WORKER_ENABLED !== 'false',
  webinar: {
    url: (process.env.WEBINAR_URL ?? '').replace(/\/+$/, ''),
    appId: process.env.WEBINAR_APP_ID ?? 'kx-commissions',
    secret: process.env.WEBINAR_APP_SECRET ?? '',
    /** Officers may open the room this many minutes before the scheduled start. */
    earlyMinutes: Number(process.env.WEBINAR_EARLY_MINUTES ?? '30'),
  },
};

if (config.dataEncryptionKey && !/^[0-9a-f]{64}$/i.test(config.dataEncryptionKey)) {
  throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)');
}

// Refuse to run in production with a sample or weak secret (the message names the variable, never the value).
if (isProd) {
  const problems = sampleSecretProblems({ jwtSecret: config.jwtSecret, dataEncryptionKey: config.dataEncryptionKey, databaseUrl: config.databaseUrl });
  if (problems.length) throw new Error(`Refusing to start in production:\n- ${problems.join('\n- ')}`);
}
