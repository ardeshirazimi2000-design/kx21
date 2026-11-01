/**
 * Security policy of the whole system (سیاست امنیتی), set by the IT administrator: password rules, temporary lockout
 * after failed sign-ins, when a CAPTCHA is asked, and session limits. Follows the AFTA requirements for network
 * applications (identification and authentication 2-3, product access 2-8); every value has a bounded range so a
 * mistaken setting cannot switch a protection off entirely.
 */
import { toPersianDigits } from './jalali.js';
import { DEMO_PASSWORD } from './secrets.js';

export interface SecurityPolicy {
  password: {
    minLength: number;
    requireLower: boolean;
    requireUpper: boolean;
    requireDigit: boolean;
    requireSymbol: boolean;
  };
  lockout: {
    /** consecutive failed sign-ins that lock the account */
    maxFailures: number;
    /** minutes the account stays locked; it unlocks by itself afterwards */
    lockMinutes: number;
    /** failed sign-ins (for the account, or from one address) after which a CAPTCHA is asked */
    captchaAfter: number;
  };
  session: {
    /** sessions one user may have at once; signing in again ends the oldest */
    maxConcurrent: number;
    /** minutes without activity after which a web session ends */
    webIdleMinutes: number;
    /** days without activity after which a mobile app session ends */
    mobileIdleDays: number;
  };
}

export const SECURITY_POLICY_LIMITS = {
  minLength: [8, 64],
  maxFailures: [3, 20],
  lockMinutes: [1, 1440],
  captchaAfter: [1, 20],
  maxConcurrent: [1, 20],
  webIdleMinutes: [5, 720],
  mobileIdleDays: [1, 90],
} as const;

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  password: { minLength: 10, requireLower: true, requireUpper: true, requireDigit: true, requireSymbol: true },
  lockout: { maxFailures: 5, lockMinutes: 15, captchaAfter: 3 },
  session: { maxConcurrent: 3, webIdleMinutes: 30, mobileIdleDays: 14 },
};

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
  typeof v === 'number' && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** The stored policy completed with defaults and held within its limits. */
export function mergeSecurityPolicy(raw: unknown): SecurityPolicy {
  const r = (raw ?? {}) as { password?: Record<string, unknown>; lockout?: Record<string, unknown>; session?: Record<string, unknown> };
  const d = DEFAULT_SECURITY_POLICY;
  const L = SECURITY_POLICY_LIMITS;
  const p = r.password ?? {};
  const l = r.lockout ?? {};
  const s = r.session ?? {};
  const maxFailures = clamp(l.maxFailures, L.maxFailures, d.lockout.maxFailures);
  return {
    password: {
      minLength: clamp(p.minLength, L.minLength, d.password.minLength),
      requireLower: bool(p.requireLower, d.password.requireLower),
      requireUpper: bool(p.requireUpper, d.password.requireUpper),
      requireDigit: bool(p.requireDigit, d.password.requireDigit),
      requireSymbol: bool(p.requireSymbol, d.password.requireSymbol),
    },
    lockout: {
      maxFailures,
      lockMinutes: clamp(l.lockMinutes, L.lockMinutes, d.lockout.lockMinutes),
      // A CAPTCHA comes before the lock, never after it.
      captchaAfter: Math.min(clamp(l.captchaAfter, L.captchaAfter, d.lockout.captchaAfter), maxFailures - 1),
    },
    session: {
      maxConcurrent: clamp(s.maxConcurrent, L.maxConcurrent, d.session.maxConcurrent),
      webIdleMinutes: clamp(s.webIdleMinutes, L.webIdleMinutes, d.session.webIdleMinutes),
      mobileIdleDays: clamp(s.mobileIdleDays, L.mobileIdleDays, d.session.mobileIdleDays),
    },
  };
}

/** What a new password lacks under the policy, as Persian sentences (empty = acceptable). */
export function passwordProblems(password: string, policy: SecurityPolicy['password'], context: { email?: string | null; mobile?: string | null } = {}): string[] {
  const out: string[] = [];
  if (password.length < policy.minLength) out.push(`رمز عبور باید دست‌کم ${toPersianDigits(String(policy.minLength))} نویسه باشد`);
  if (policy.requireLower && !/[a-z]/.test(password)) out.push('رمز عبور باید حرف کوچک لاتین (a-z) داشته باشد');
  if (policy.requireUpper && !/[A-Z]/.test(password)) out.push('رمز عبور باید حرف بزرگ لاتین (A-Z) داشته باشد');
  if (policy.requireDigit && !/[0-9]/.test(password)) out.push('رمز عبور باید عدد داشته باشد');
  if (policy.requireSymbol && !/[^A-Za-z0-9\s]/.test(password)) out.push('رمز عبور باید یک نویسهٔ خاص مثل ! @ # $ % داشته باشد');
  if (/\s/.test(password)) out.push('رمز عبور نباید فاصله داشته باشد');
  const lower = password.toLowerCase();
  if (lower.includes(DEMO_PASSWORD.toLowerCase())) out.push('رمز عبور نباید رمز نمونهٔ سامانه را داشته باشد');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if ((local && local.length >= 4 && lower.includes(local)) || (context.mobile && context.mobile.length >= 8 && password.includes(context.mobile))) {
    out.push('رمز عبور نباید نام کاربری یا شمارهٔ موبایل را داشته باشد');
  }
  return out;
}

/** The rules in one line, for the form that sets a password. */
export function passwordRulesText(policy: SecurityPolicy['password']): string {
  const parts = [`دست‌کم ${toPersianDigits(String(policy.minLength))} نویسه`];
  if (policy.requireUpper && policy.requireLower) parts.push('حرف بزرگ و کوچک لاتین');
  else if (policy.requireUpper) parts.push('حرف بزرگ لاتین');
  else if (policy.requireLower) parts.push('حرف کوچک لاتین');
  if (policy.requireDigit) parts.push('عدد');
  if (policy.requireSymbol) parts.push('یک نویسهٔ خاص');
  return parts.join('، ');
}
