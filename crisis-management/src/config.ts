import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://crisis:crisis@localhost:5432/crisis'),
  /** Comma-separated list of allowed browser origins (empty = same-origin only). */
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),

  /** Secrets: at least 32 chars each. Must be set in production. */
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-0123456789'),
  OTP_PEPPER: z.string().min(32).default('dev-only-otp-pepper-change-me-0123456789'),

  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(15 * 60),
  /** Console sessions are shorter than app sessions (privileged channel). */
  CONSOLE_REFRESH_TTL_SEC: z.coerce.number().int().default(8 * 3600),
  APP_REFRESH_TTL_SEC: z.coerce.number().int().default(30 * 24 * 3600),
  /** Idle timeout of console sessions: refresh is rejected after this much inactivity. */
  CONSOLE_IDLE_TIMEOUT_SEC: z.coerce.number().int().default(30 * 60),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SEC: z.coerce.number().int().default(120),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().default(60),
  OTP_MAX_PER_HOUR: z.coerce.number().int().default(5),

  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().default(12),
  PASSWORD_MAX_AGE_DAYS: z.coerce.number().int().default(90),
  LOGIN_MAX_FAILURES: z.coerce.number().int().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().default(15),

  /** Re-run Shahkar on app login when the last successful match is older than this (SIM ownership can change). */
  SHAHKAR_REVERIFY_DAYS: z.coerce.number().int().default(180),
  /** A first app sign-in from a device not seen before for this user also goes through Shahkar. */
  SHAHKAR_ON_NEW_DEVICE: bool.default(true),
  /** Allow citizens to self-enrol from the app (Shahkar + OTP). Staff are always created in the console. */
  APP_CITIZEN_SIGNUP: bool.default(true),

  /** api.ir gateway (Shahkar + SMS OTP). mock = offline simulator for development/tests only. */
  APIIR_MODE: z.enum(['live', 'mock']).default('mock'),
  APIIR_BASE_URL: z.string().url().default('https://s.api.ir'),
  APIIR_TOKEN: z.string().default(''),
  APIIR_SHAHKAR_ENDPOINT: z.enum(['Shahkar', 'ShahkarPro', 'ShahkarLite']).default('ShahkarPro'),
  /** SmsOTP template: 0 کد, 1 کد ورود, 2 کد تایید, 3 رمز, 4 رمز ورود */
  APIIR_OTP_TEMPLATE: z.coerce.number().int().min(0).max(4).default(1),
  APIIR_TIMEOUT_MS: z.coerce.number().int().default(10000),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const cfg = schema.parse(process.env);
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (cfg.JWT_SECRET.startsWith('dev-only')) problems.push('JWT_SECRET');
    if (cfg.OTP_PEPPER.startsWith('dev-only')) problems.push('OTP_PEPPER');
    if (cfg.APIIR_MODE !== 'live') problems.push('APIIR_MODE must be live');
    if (!cfg.APIIR_TOKEN) problems.push('APIIR_TOKEN');
    if (problems.length) throw new Error(`Insecure production configuration: ${problems.join(', ')}`);
  }
  return cfg;
}

export const config = load();
