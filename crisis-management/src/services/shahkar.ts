import { config } from '../config.js';
import { pool, type Db } from '../db/pool.js';
import { apiIr, type ShahkarResult } from '../integrations/apiir.js';
import { HttpError, upstream } from '../lib/errors.js';
import { maskMobile, maskNationalCode } from '../lib/identity.js';

export type ShahkarContext = 'console_user_create' | 'console_user_update' | 'console_manual' | 'console_reverify' | 'console_login' | 'app_enroll' | 'app_signup';

export interface ShahkarCheck {
  nationalCode: string;
  mobile: string;
  context: ShahkarContext;
  userId?: string | null;
  requestedBy?: string | null;
}

/** Calls Shahkar and records the inquiry. Never throws for a mismatch; throws 502 if the provider failed. */
export async function inquireShahkar(c: ShahkarCheck, db: Db = pool): Promise<ShahkarResult> {
  const r = await apiIr.shahkar(c.nationalCode, c.mobile, false);
  await db.query(
    `INSERT INTO shahkar_inquiries (user_id, requested_by, context, national_code_masked, mobile_masked, endpoint, matched, success, provider_code, provider_message, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [c.userId ?? null, c.requestedBy ?? null, c.context, maskNationalCode(c.nationalCode), maskMobile(c.mobile), r.endpoint, r.matched, r.ok, r.code ?? null, r.message?.slice(0, 500) ?? null, r.durationMs],
  );
  if (!r.ok) throw upstream('سامانه شاهکار در حال حاضر پاسخگو نیست؛ لطفاً دقایقی بعد تلاش کنید');
  return r;
}

/** Shahkar check that must match (fail-closed): throws 422 on mismatch. */
export async function requireShahkarMatch(c: ShahkarCheck, db: Db = pool): Promise<void> {
  const r = await inquireShahkar(c, db);
  if (!r.matched) {
    throw new HttpError(422, 'شماره موبایل متعلق به صاحب این کد ملی نیست (عدم تطابق شاهکار)', 'shahkar_mismatch');
  }
}

export function shahkarIsStale(verifiedAt: Date | string | null): boolean {
  if (!verifiedAt) return true;
  return Date.now() - new Date(verifiedAt).getTime() > config.SHAHKAR_REVERIFY_DAYS * 86400_000;
}
