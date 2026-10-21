// Dates in minutes/notifications are rendered in Iran time unless configured otherwise.
process.env.TZ ??= 'Asia/Tehran';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  isTest: process.env.NODE_ENV === 'test' || !!process.env.VITEST,
  port: Number(env('PORT', '4000')),
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
  /**
   * Official holidays web service (تقویم رسمی): sapi = s.api.ir IsHoliday (uses IDENTITY_API_TOKEN unless
   * HOLIDAY_API_TOKEN is set), mock = fixed holidays for tests, none = only Fridays and holidays defined here.
   */
  holidayProvider: (process.env.HOLIDAY_PROVIDER ||
    (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'mock' : process.env.HOLIDAY_API_TOKEN || process.env.IDENTITY_API_TOKEN ? 'sapi' : 'none')) as 'sapi' | 'mock' | 'none',
  holidayApiUrl: process.env.HOLIDAY_API_URL || 'https://s.api.ir/api/sw1/IsHoliday',
  holidayApiToken: process.env.HOLIDAY_API_TOKEN || process.env.IDENTITY_API_TOKEN,
  /** Ask for confirmation before a meeting is scheduled on a holiday. */
  meetingHolidayCheck: process.env.MEETING_HOLIDAY_CHECK !== 'false',
  /** How the date is sent: jalali = 1404/07/29, gregorian = 2025-10-21. */
  holidayApiDateFormat: (process.env.HOLIDAY_API_DATE_FORMAT || 'jalali') as 'jalali' | 'gregorian',
  /** The service is known to accept the date as configured above (otherwise the admin page's detection decides). */
  holidayApiDateVerified: process.env.HOLIDAY_API_DATE_VERIFIED === 'true',
  /** Built web app (apps/web/dist) to serve from this process, for single-port installs. */
  webDistDir: process.env.WEB_DIST_DIR,
  /** Set to true once the site is served over HTTPS (enables HSTS and upgrade-insecure-requests). */
  publicHttps: process.env.PUBLIC_HTTPS === 'true',
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
  },
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

if (isProd && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
