// Dates in letters/notifications are rendered in Iran time unless configured otherwise.
process.env.TZ ??= 'Asia/Tehran';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;

export const config = {
  isProd,
  isTest,
  port: Number(env('PORT', '4100')),
  databaseUrl: env('DATABASE_URL', 'postgres://kx:kx@localhost:5432/kx_office'),
  jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-only-office-secret-do-not-use-in-production'),
  accessTokenTtl: env('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtlDays: Number(env('REFRESH_TOKEN_TTL_DAYS', '14')),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5174').split(',').map((s) => s.trim()),
  /** Public address of the web app (QR codes on letters point to /verify/<code>). */
  publicUrl: env('PUBLIC_URL', 'http://localhost:5174').replace(/\/+$/, ''),
  /**
   * 64 hex chars (AES-256) used for files and secrets at rest. Required in production;
   * development derives one from JWT_SECRET.
   */
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY,
  storageDriver: env('STORAGE_DRIVER', 'local') as 'local',
  storageDir: env('STORAGE_DIR', './storage'),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '50')),
  /** Users holding these roles must enable two-factor authentication before using the system. */
  mfaRequiredRoles: (process.env.MFA_REQUIRED_ROLES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  smsProvider: env('SMS_PROVIDER', 'log') as 'log' | 'kavenegar',
  kavenegarApiKey: process.env.KAVENEGAR_API_KEY,
  kavenegarSender: process.env.KAVENEGAR_SENDER,
  emailProvider: env('EMAIL_PROVIDER', 'log') as 'log' | 'smtp',
  smtpUrl: process.env.SMTP_URL,
  emailFrom: process.env.EMAIL_FROM ?? 'اتوماسیون اداری <no-reply@chamber.local>',
  workerEnabled: process.env.WORKER_ENABLED !== 'false',
  workerIntervalSeconds: Number(env('WORKER_INTERVAL_SECONDS', '5')),
  schedulerIntervalSeconds: Number(env('SCHEDULER_INTERVAL_SECONDS', '300')),
  webDistDir: process.env.WEB_DIST_DIR,
  publicHttps: process.env.PUBLIC_HTTPS === 'true',
};

if (config.dataEncryptionKey && !/^[0-9a-f]{64}$/i.test(config.dataEncryptionKey)) {
  throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)');
}
if (isProd && config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
if (isProd && !config.dataEncryptionKey) throw new Error('DATA_ENCRYPTION_KEY is required in production');
