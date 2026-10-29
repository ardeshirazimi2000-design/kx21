// Visit length options set by the administrator (system settings): which durations doctors may
// choose when publishing their calendar, and the pre-selected one.
import { badRequest } from './http.js';
import { nowIso, parseJson } from './db.js';

export const VISIT_DEFAULTS = { durations: [15, 20, 30, 45, 60], default: 30, join_early_min: 10, cancel_refund_hours: 24 };
// The visit room stays open this long after the visit's scheduled end.
export const JOIN_LATE_MIN = 30;
const valid = (m) => Number.isInteger(m) && m >= 5 && m <= 120 && m % 5 === 0;
const validRefundHours = (h) => Number.isInteger(h) && h >= 0 && h <= 168;

export function getVisitSettings(db, tenantId) {
  const v = parseJson(db.get(`SELECT value FROM settings WHERE tenant_id = ? AND key = 'visit'`, tenantId)?.value, {});
  const durations = Array.isArray(v.durations) ? [...new Set(v.durations.filter(valid))].sort((a, b) => a - b) : [];
  const early = Number.isInteger(v.join_early_min) && v.join_early_min >= 0 && v.join_early_min <= 60 ? v.join_early_min : VISIT_DEFAULTS.join_early_min;
  // A patient who cancels at least this many hours before the visit gets the fee back.
  const refundH = validRefundHours(v.cancel_refund_hours) ? v.cancel_refund_hours : VISIT_DEFAULTS.cancel_refund_hours;
  if (!durations.length) return { ...VISIT_DEFAULTS, durations: [...VISIT_DEFAULTS.durations], join_early_min: early, cancel_refund_hours: refundH };
  return { durations, default: durations.includes(v.default) ? v.default : durations[0], join_early_min: early, cancel_refund_hours: refundH };
}

export function setVisitSettings(db, ctx, input) {
  const list = Array.isArray(input.durations) ? input.durations.map(Number) : null;
  if (!list || !list.length) throw badRequest('حداقل یک مدت ویزیت را انتخاب کنید');
  if (!list.every(valid)) throw badRequest('مدت ویزیت باید بین ۵ تا ۱۲۰ دقیقه و مضرب ۵ باشد');
  const durations = [...new Set(list)].sort((a, b) => a - b);
  const def = input.default === undefined ? durations[0] : Number(input.default);
  if (!durations.includes(def)) throw badRequest('مدت پیش‌فرض باید یکی از مدت‌های انتخاب‌شده باشد');
  const early = input.join_early_min === undefined ? getVisitSettings(db, ctx.tenantId).join_early_min : Number(input.join_early_min);
  if (!Number.isInteger(early) || early < 0 || early > 60) throw badRequest('زمان باز شدن اتاق ویزیت باید بین ۰ تا ۶۰ دقیقه قبل از نوبت باشد');
  const refundH = input.cancel_refund_hours === undefined ? getVisitSettings(db, ctx.tenantId).cancel_refund_hours : Number(input.cancel_refund_hours);
  if (!validRefundHours(refundH)) throw badRequest('مهلت لغو با بازگشت وجه باید بین ۰ تا ۱۶۸ ساعت باشد');
  const value = { durations, default: def, join_early_min: early, cancel_refund_hours: refundH };
  db.run(
    `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, 'visit', ?, ?, ?)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ctx.tenantId, JSON.stringify(value), nowIso(), ctx.user.sub,
  );
  return value;
}

// Support desk: after how many minutes without an answer a waiting conversation is reported to the
// support supervisors (0 = never).
export const SUPPORT_DEFAULTS = { alert_minutes: 30 };
export function getSupportSettings(db, tenantId) {
  const v = parseJson(db.get(`SELECT value FROM settings WHERE tenant_id = ? AND key = 'support'`, tenantId)?.value, {});
  return { alert_minutes: Number.isInteger(v.alert_minutes) && v.alert_minutes >= 0 && v.alert_minutes <= 1440 ? v.alert_minutes : SUPPORT_DEFAULTS.alert_minutes };
}
export function setSupportSettings(db, ctx, input) {
  const m = Number(input.alert_minutes);
  if (!Number.isInteger(m) || m < 0 || m > 1440) throw badRequest('زمان هشدار تأخیر پشتیبانی باید بین ۰ تا ۱۴۴۰ دقیقه باشد');
  const value = { alert_minutes: m };
  db.run(
    `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, 'support', ?, ?, ?)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ctx.tenantId, JSON.stringify(value), nowIso(), ctx.user.sub,
  );
  return value;
}
