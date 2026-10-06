import { isValidNationalCode, normalizeNationalCode, toLatinDigits } from '@kx/shared';
import { config } from '../config.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export interface IdentityResult {
  nationalCode: string;
  birthDate: string; // Jalali, e.g. 1371/1/1
  firstName: string;
  lastName: string;
  fatherName: string | null;
  fullName: string;
  source: string;
  /** Provider response with personal data minimised (stored for audit). */
  raw: unknown;
}

/** "۱۳۷۱/۰۱/۰۱" | "1371-1-1" → "1371/1/1" (the format of the PersonInfo service). */
export function normalizeBirthDate(input: string): string {
  const m = toLatinDigits(input.trim()).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) throw badRequest('تاریخ تولد باید به شکل ۱۳۷۱/۰۱/۰۱ باشد');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1280 || y > 1500 || mo < 1 || mo > 12 || d < 1 || d > 31) throw badRequest('تاریخ تولد معتبر نیست');
  return `${y}/${mo}/${d}`;
}

/** Finds the first string value under any of the given keys, searching nested objects (response shapes vary). */
function pick(obj: unknown, keys: string[], depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (keys.includes(k.toLowerCase()) && typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
  }
  for (const v of Object.values(o)) {
    const r = pick(v, keys, depth + 1);
    if (r) return r;
  }
  return null;
}

const FIRST = ['firstname', 'first_name', 'name', 'fname', 'nam'];
const LAST = ['lastname', 'last_name', 'family', 'familyname', 'family_name', 'surname', 'lname', 'famil'];
const FATHER = ['fathername', 'father_name', 'father', 'fathersname'];

async function sapi(nationalCode: string, birthDate: string): Promise<IdentityResult> {
  if (!config.identityApiToken) throw new HttpError(503, 'identity_not_configured', 'توکن سرویس استعلام هویت تنظیم نشده است');
  let res: Response;
  try {
    res = await fetch(config.identityApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.identityApiToken}` },
      body: JSON.stringify({ nationalCode, birthDate }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'identity service unreachable');
    throw new HttpError(502, 'identity_unavailable', 'سرویس استعلام هویت در دسترس نیست؛ کمی بعد تلاش کنید');
  }
  const body: any = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    logger.error({ status: res.status }, 'identity service rejected the token');
    throw new HttpError(502, 'identity_auth_failed', 'دسترسی به سرویس استعلام هویت رد شد (توکن نامعتبر یا منقضی)');
  }
  if (!res.ok) {
    throw new HttpError(422, 'identity_not_found', pick(body, ['message', 'error', 'description']) ?? 'کد ملی و تاریخ تولد با اطلاعات ثبت احوال مطابقت ندارد');
  }
  const firstName = pick(body, FIRST);
  const lastName = pick(body, LAST);
  if (!firstName || !lastName) {
    logger.warn({ keys: body && typeof body === 'object' ? Object.keys(body) : typeof body }, 'identity response without names');
    throw new HttpError(422, 'identity_not_found', pick(body, ['message', 'error']) ?? 'اطلاعات هویتی برای این کد ملی یافت نشد');
  }
  const fatherName = pick(body, FATHER);
  return { nationalCode, birthDate, firstName, lastName, fatherName, fullName: `${firstName} ${lastName}`, source: 'sapi', raw: body };
}

/** Deterministic fake registry for development and tests. */
function mock(nationalCode: string, birthDate: string): IdentityResult {
  if (nationalCode.endsWith('99') && birthDate.startsWith('1300')) {
    throw new HttpError(422, 'identity_not_found', 'کد ملی و تاریخ تولد با اطلاعات ثبت احوال مطابقت ندارد');
  }
  const firstName = 'شخص';
  const lastName = `آزمایشی ${nationalCode.slice(-4)}`;
  return { nationalCode, birthDate, firstName, lastName, fatherName: 'نمونه', fullName: `${firstName} ${lastName}`, source: 'mock', raw: { mock: true } };
}

export function identityEnabled() {
  return config.identityProvider !== 'none';
}

export async function inquireIdentity(nationalCodeInput: string, birthDateInput: string): Promise<IdentityResult> {
  const nationalCode = normalizeNationalCode(nationalCodeInput);
  if (!isValidNationalCode(nationalCode)) throw badRequest('کد ملی معتبر نیست');
  const birthDate = normalizeBirthDate(birthDateInput);
  if (config.identityProvider === 'sapi') return sapi(nationalCode, birthDate);
  if (config.identityProvider === 'mock') return mock(nationalCode, birthDate);
  throw new HttpError(503, 'identity_disabled', 'استعلام هویت در این سامانه فعال نشده است');
}
