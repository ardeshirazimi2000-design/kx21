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
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '20')),
  smsProvider: env('SMS_PROVIDER', 'log'),
  emailProvider: env('EMAIL_PROVIDER', 'log'),
  pushProvider: env('PUSH_PROVIDER', 'log'),
  kavenegarApiKey: process.env.KAVENEGAR_API_KEY,
  kavenegarSender: process.env.KAVENEGAR_SENDER,
  schedulerIntervalSeconds: Number(env('SCHEDULER_INTERVAL_SECONDS', '300')),
};

if (isProd && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
