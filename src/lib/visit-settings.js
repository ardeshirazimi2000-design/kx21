// Visit length options set by the administrator (system settings): which durations doctors may
// choose when publishing their calendar, and the pre-selected one.
import { badRequest } from './http.js';
import { nowIso, parseJson } from './db.js';

export const VISIT_DEFAULTS = { durations: [15, 20, 30, 45, 60], default: 30 };
const valid = (m) => Number.isInteger(m) && m >= 5 && m <= 120 && m % 5 === 0;

export function getVisitSettings(db, tenantId) {
  const v = parseJson(db.get(`SELECT value FROM settings WHERE tenant_id = ? AND key = 'visit'`, tenantId)?.value, {});
  const durations = Array.isArray(v.durations) ? [...new Set(v.durations.filter(valid))].sort((a, b) => a - b) : [];
  if (!durations.length) return { ...VISIT_DEFAULTS, durations: [...VISIT_DEFAULTS.durations] };
  return { durations, default: durations.includes(v.default) ? v.default : durations[0] };
}

export function setVisitSettings(db, ctx, input) {
  const list = Array.isArray(input.durations) ? input.durations.map(Number) : null;
  if (!list || !list.length) throw badRequest('حداقل یک مدت ویزیت را انتخاب کنید');
  if (!list.every(valid)) throw badRequest('مدت ویزیت باید بین ۵ تا ۱۲۰ دقیقه و مضرب ۵ باشد');
  const durations = [...new Set(list)].sort((a, b) => a - b);
  const def = input.default === undefined ? durations[0] : Number(input.default);
  if (!durations.includes(def)) throw badRequest('مدت پیش‌فرض باید یکی از مدت‌های انتخاب‌شده باشد');
  const value = { durations, default: def };
  db.run(
    `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, 'visit', ?, ?, ?)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ctx.tenantId, JSON.stringify(value), nowIso(), ctx.user.sub,
  );
  return value;
}
