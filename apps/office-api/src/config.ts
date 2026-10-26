import net from 'node:net';
import { sampleSecretProblems } from '@kx/shared';

// Dates in letters/notifications are rendered in Iran time unless configured otherwise.
process.env.TZ ??= 'Asia/Tehran';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/**
 * Which reverse proxies may set X-Forwarded-For / X-Forwarded-Proto (Express `trust proxy`):
 *  unset, "", "false", "0" → none: the client address is the TCP peer (systemd install with no proxy in front);
 *  a number → that many proxy hops in front of the app (Docker: 1 = the office-web nginx);
 *  a comma list of addresses, CIDR ranges or loopback / linklocal / uniquelocal → only those proxies.
 * "true" (trust whoever connects) is refused: any client could then choose its own address.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const v = (raw ?? '').trim();
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

function flag(name: string): boolean {
  return ['true', '1'].includes((process.env[name] ?? '').trim().toLowerCase());
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
  /** Interface the API listens on; unset = all interfaces (as before). 127.0.0.1 when a proxy on this server is the only entry. */
  host: process.env.HOST || undefined,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /**
   * The system is reached over HTTPS (TLS ends at the office-web nginx or a reverse proxy in front): sign-in refuses
   * plain-HTTP requests and responses carry Strict-Transport-Security.
   */
  publicHttps: flag('PUBLIC_HTTPS'),
  /** HSTS lifetime in seconds ("off" = no header); start short (one day) and raise it once HTTPS is known to work. */
  hstsMaxAge: env('HSTS_MAX_AGE', '86400') === 'off' ? null : Number(env('HSTS_MAX_AGE', '86400')),
  /** Off by default: other sites under the same domain may still be on HTTP. */
  hstsIncludeSubDomains: flag('HSTS_INCLUDE_SUBDOMAINS'),
};

if (config.hstsMaxAge !== null && (!Number.isInteger(config.hstsMaxAge) || config.hstsMaxAge < 0)) {
  throw new Error('HSTS_MAX_AGE must be a whole number of seconds or off');
}

if (config.dataEncryptionKey && !/^[0-9a-f]{64}$/i.test(config.dataEncryptionKey)) {
  throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)');
}
// Refuse to run in production with a sample or weak secret (the message names the variable, never the value).
if (isProd) {
  const problems = sampleSecretProblems({ jwtSecret: config.jwtSecret, dataEncryptionKey: config.dataEncryptionKey, databaseUrl: config.databaseUrl });
  if (problems.length) throw new Error(`Refusing to start in production:\n- ${problems.join('\n- ')}`);
}
if (isProd && !config.dataEncryptionKey) throw new Error('DATA_ENCRYPTION_KEY is required in production');
