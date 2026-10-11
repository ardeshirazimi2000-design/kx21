import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { apiIr } from '../integrations/apiir.js';
import { hmac, randomDigits, safeEqualHex } from '../lib/crypto.js';
import { HttpError, tooMany, upstream } from '../lib/errors.js';
import { maskMobile } from '../lib/identity.js';
import type { Channel } from '../security/roles.js';

export type OtpPurpose = 'console_login' | 'app_enroll' | 'app_login' | 'app_signup';

export interface IssueOtp {
  channel: Channel;
  purpose: OtpPurpose;
  mobile: string;
  userId?: string | null;
  nationalCode?: string | null;
  pendingProfile?: Record<string, unknown> | null;
  ip?: string | null;
  deviceId?: string | null;
}

export interface OtpChallenge {
  challengeId: string;
  mobileMasked: string;
  expiresIn: number;
  resendAfter: number;
}

function codeHash(challengeId: string, code: string) {
  return hmac(`${challengeId}:${code}`);
}

/** Creates a challenge and delivers the code via api.ir SmsOTP. Per-mobile cooldown and hourly cap. */
export async function issueOtp(o: IssueOtp): Promise<OtpChallenge> {
  const recent = await one<{ last_at: string | null; hour_count: string }>(
    `SELECT max(created_at) AS last_at, count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour_count
       FROM auth_challenges WHERE mobile = $1 AND created_at > now() - interval '1 hour'`,
    [o.mobile],
  );
  if (recent?.last_at) {
    const wait = config.OTP_RESEND_COOLDOWN_SEC - Math.floor((Date.now() - new Date(recent.last_at).getTime()) / 1000);
    if (wait > 0) throw tooMany(`ارسال مجدد کد تا ${wait} ثانیه دیگر امکان‌پذیر است`, wait);
  }
  if (Number(recent?.hour_count ?? 0) >= config.OTP_MAX_PER_HOUR) throw tooMany('سقف ارسال کد در یک ساعت تکمیل شده است');

  // Supersede any earlier pending challenge for this mobile.
  await pool.query('UPDATE auth_challenges SET consumed_at = now() WHERE mobile = $1 AND consumed_at IS NULL', [o.mobile]);

  const code = randomDigits(config.OTP_LENGTH);
  const row = await one<{ id: string }>(
    `INSERT INTO auth_challenges (user_id, channel, purpose, mobile, national_code, pending_profile, code_hash, ip, device_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8, now() + make_interval(secs => $9)) RETURNING id`,
    [o.userId ?? null, o.channel, o.purpose, o.mobile, o.nationalCode ?? null, o.pendingProfile ?? null, o.ip ?? null, o.deviceId ?? null, config.OTP_TTL_SEC],
  );
  await pool.query('UPDATE auth_challenges SET code_hash = $2 WHERE id = $1', [row!.id, codeHash(row!.id, code)]);

  const sent = await apiIr.sendOtp(o.mobile, code);
  if (!sent.ok) {
    await pool.query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1', [row!.id]);
    throw upstream('ارسال پیامک کد تأیید ناموفق بود؛ لطفاً دوباره تلاش کنید');
  }
  return { challengeId: row!.id, mobileMasked: maskMobile(o.mobile), expiresIn: config.OTP_TTL_SEC, resendAfter: config.OTP_RESEND_COOLDOWN_SEC };
}

export interface VerifiedChallenge {
  id: string;
  userId: string | null;
  channel: Channel;
  purpose: OtpPurpose;
  mobile: string;
  nationalCode: string | null;
  pendingProfile: Record<string, unknown> | null;
  deviceId: string | null;
}

/**
 * Checks a code. Wrong codes count against OTP_MAX_ATTEMPTS, after which the challenge is burned.
 * `consume=false` validates without consuming (used when more input is still required).
 */
export async function verifyOtp(challengeId: string, code: string, channel: Channel, consume = true): Promise<VerifiedChallenge> {
  const invalid = () => new HttpError(400, 'کد تأیید نادرست یا منقضی است', 'otp_invalid');
  if (!/^[0-9a-f-]{36}$/.test(challengeId)) throw invalid();
  const c = await one<{
    id: string; user_id: string | null; channel: Channel; purpose: OtpPurpose; mobile: string; national_code: string | null;
    pending_profile: Record<string, unknown> | null; device_id: string | null; code_hash: string; attempts: number; expired: boolean; consumed_at: string | null;
  }>(
    `SELECT id, user_id, channel, purpose, mobile, national_code, pending_profile, device_id, code_hash, attempts, consumed_at,
            expires_at < now() AS expired
       FROM auth_challenges WHERE id = $1`,
    [challengeId],
  );
  if (!c || c.channel !== channel || c.consumed_at || c.expired || c.attempts >= config.OTP_MAX_ATTEMPTS) throw invalid();
  if (!/^\d+$/.test(code) || !safeEqualHex(codeHash(c.id, code), c.code_hash)) {
    const r = await query<{ attempts: number }>('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [c.id]);
    const left = config.OTP_MAX_ATTEMPTS - (r[0]?.attempts ?? config.OTP_MAX_ATTEMPTS);
    throw new HttpError(400, left > 0 ? `کد تأیید نادرست است (${left} تلاش باقی‌مانده)` : 'تعداد تلاش‌ها تمام شد؛ کد جدید دریافت کنید', 'otp_invalid');
  }
  if (consume) {
    const r = await query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id', [c.id]);
    if (r.length === 0) throw invalid(); // raced with a concurrent verification
  }
  return {
    id: c.id, userId: c.user_id, channel: c.channel, purpose: c.purpose, mobile: c.mobile,
    nationalCode: c.national_code, pendingProfile: c.pending_profile, deviceId: c.device_id,
  };
}
