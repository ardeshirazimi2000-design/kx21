import { JALALI_MONTHS, toGregorian as toGregorianDay, toJalali, toPersianDigits } from '@kx/shared';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Holidays (تعطیلات) for the meetings calendar: Fridays, holidays defined in the system (nationwide by the
 * Super Admin or for one chamber by its admin) and the official calendar web service (s.api.ir IsHoliday),
 * whose answers are cached per day.
 */

export interface Holiday {
  date: string; // YYYY-MM-DD (Gregorian, Tehran)
  title: string;
  source: 'friday' | 'official' | 'national' | 'chamber';
  id?: string;
}

/** Calendar day of an instant in Iran (meetings are stored as instants). */
export function tehranDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
const isFriday = (date: string) => {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 5;
};
const pad = (n: number) => String(n).padStart(2, '0');
export const jalaliText = (date: string) => {
  const [jy, jm, jd] = toJalali(...parts(date));
  return `${jy}/${pad(jm)}/${pad(jd)}`;
};

// ─────────────────────────── official calendar web service ───────────────────────────

/** true/false written in any of the usual ways ("true", 1, "بله"…), or null. */
function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'بله', 'تعطیل'].includes(t)) return true;
    if (['false', '0', 'no', 'خیر', 'کاری'].includes(t)) return false;
  }
  return null;
}

/** The first yes/no value whose key mentions a holiday, searching nested objects (response shapes vary). */
function findFlag(obj: unknown, depth = 0): boolean | null {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  const o = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (/holiday|tatil|off$/i.test(k) && asBool(v) !== null) return asBool(v);
  }
  for (const v of Object.values(o)) {
    const r = findFlag(v, depth + 1);
    if (r !== null) return r;
  }
  // A bare answer: {"data": true} or {"result": "true"}.
  if (depth === 0) for (const k of ['data', 'result', 'value', 'response']) if (k in o && asBool(o[k]) !== null) return asBool(o[k]);
  return null;
}

const TITLE_KEYS = ['description', 'title', 'event', 'events', 'occasion', 'reason', 'holidayname', 'holiday_name', 'holidaytitle', 'name'];

/** Occasion text(s) of the day, e.g. «عید نوروز». */
function findTitle(obj: unknown, depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  const texts = (v: unknown): string[] =>
    typeof v === 'string' ? [v.trim()] : Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? [x.trim()] : (findTitle(x, depth + 1) ?? '').split('، '))) : [];
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!TITLE_KEYS.includes(k.toLowerCase())) continue;
    const t = texts(o[k]).filter(Boolean);
    if (t.length) return [...new Set(t)].join('، ');
  }
  for (const v of Object.values(o)) {
    const r = findTitle(v, depth + 1);
    if (r) return r;
  }
  return null;
}

export interface OfficialAnswer {
  isHoliday: boolean;
  title: string | null;
  raw?: unknown;
}

/**
 * How the day is sent to the web service: the field name and the date format. Its documentation is not public,
 * so the Super Admin can detect it (detectDateStyle); the default comes from HOLIDAY_API_DATE_FORMAT.
 */
export interface DateStyle {
  field: string;
  /** j = 1405/01/03, jn = 1405/1/3, jd = 1405-01-03, g = 2026-03-23, giso = 2026-03-23T00:00:00 */
  format: 'j' | 'jn' | 'jd' | 'g' | 'giso';
}
const STYLE_KEY = 'holiday_api_date_style';
let style: DateStyle | null = null;

export async function dateStyle(): Promise<DateStyle> {
  if (style) return style;
  const row = await query<{ value: DateStyle }>('SELECT value FROM app_settings WHERE key = $1', [STYLE_KEY]).catch(() => []);
  style = row[0]?.value ?? { field: 'date', format: config.holidayApiDateFormat === 'gregorian' ? 'g' : 'j' };
  return style;
}

function formatFor(date: string, format: DateStyle['format']) {
  const [jy, jm, jd] = toJalali(...parts(date));
  switch (format) {
    case 'jn':
      return `${jy}/${jm}/${jd}`;
    case 'jd':
      return `${jy}-${pad(jm)}-${pad(jd)}`;
    case 'g':
      return date;
    case 'giso':
      return `${date}T00:00:00`;
    default:
      return `${jy}/${pad(jm)}/${pad(jd)}`;
  }
}

async function sapi(date: string, using?: DateStyle): Promise<OfficialAnswer> {
  const token = (config.holidayApiToken ?? '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(503, 'holiday_not_configured', 'توکن سرویس تقویم رسمی تنظیم نشده است');
  const st = using ?? (await dateStyle());
  const sent = { [st.field]: formatFor(date, st.format), weekend: true };
  let res: Response;
  try {
    res = await fetch(config.holidayApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(sent),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new HttpError(502, 'holiday_unavailable', `سرویس تقویم رسمی در دسترس نیست (${(e as Error).message})`);
  }
  const text = await res.text().catch(() => '');
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the beginning of the text so the admin's test can show what came back.
    body = { httpStatus: res.status, text: text.slice(0, 2000) };
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'holiday_auth_failed', 'دسترسی به سرویس تقویم رسمی رد شد (توکن نامعتبر یا منقضی)');
  if (!res.ok) throw Object.assign(new HttpError(502, 'holiday_failed', `پاسخ نامعتبر از سرویس تقویم رسمی (کد ${res.status})`), { raw: { sent, received: body } });
  const flag = findFlag(body);
  if (flag === null) {
    logger.warn({ keys: body && typeof body === 'object' ? Object.keys(body) : typeof body }, 'holiday response without a holiday flag');
    throw Object.assign(new HttpError(502, 'holiday_unrecognized', 'پاسخ سرویس تقویم رسمی قابل تشخیص نبود'), { raw: { sent, received: body } });
  }
  return { isHoliday: flag, title: flag ? findTitle(body) : null, raw: { sent, received: body } };
}

/** Field names and formats tried, most likely first. */
const CANDIDATES: DateStyle[] = [
  ...(['date', 'Date'] as const).flatMap((field) => (['j', 'jn', 'jd', 'g', 'giso'] as const).map((format) => ({ field, format }))),
  ...(['persianDate', 'jalaliDate', 'shamsiDate', 'PersianDate', 'dateFa'] as const).flatMap((field) => (['j', 'jn', 'jd'] as const).map((format) => ({ field, format }))),
  ...(['dateTime', 'gregorianDate', 'day'] as const).flatMap((field) => (['g', 'giso'] as const).map((format) => ({ field, format }))),
];

/**
 * Finds how the web service expects the day: the first style for which 1 Farvardin is a holiday and an
 * ordinary working day is not (a service that ignores the date answers both the same). The result is stored.
 */
export async function detectDateStyle(userId: string) {
  if (config.holidayProvider !== 'sapi') throw new HttpError(503, 'holiday_disabled', 'سرویس تقویم رسمی فعال نشده است');
  const now = new Date();
  const [jy] = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const g = (m: number, d: number) => {
    const [y, mo, da] = toGregorianDay(jy, m, d);
    return `${y}-${pad(mo)}-${pad(da)}`;
  };
  const holiday = g(1, 1); // نوروز
  // Ordinary working days (two, in case a lunar holiday falls on one of them in some year).
  const workdays = [g(1, 17), g(2, 10)];
  const tried: { field: string; format: string; sent: string; holiday: boolean | null; workday?: boolean | null }[] = [];
  for (const c of CANDIDATES) {
    const h = await sapi(holiday, c).then((a) => a.isHoliday, () => null);
    const t = { field: c.field, format: c.format, sent: formatFor(holiday, c.format), holiday: h } as (typeof tried)[number];
    tried.push(t);
    if (h !== true) continue;
    for (const w of workdays) {
      t.workday = await sapi(w, c).then((a) => a.isHoliday, () => null);
      if (t.workday === false) break;
    }
    if (t.workday !== false) continue;
    await query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [STYLE_KEY, JSON.stringify(c), userId],
    );
    style = c;
    // Earlier answers were asked with another format.
    await query('DELETE FROM holiday_lookups');
    return { found: true, style: c, tried };
  }
  return { found: false, style: await dateStyle(), tried };
}

/** Fixed official holidays for development and tests (Jalali month/day). */
const MOCK: Record<string, string> = {
  '01/01': 'عید نوروز',
  '01/02': 'عید نوروز',
  '01/03': 'عید نوروز',
  '01/04': 'عید نوروز',
  '01/12': 'روز جمهوری اسلامی',
  '01/13': 'روز طبیعت',
  '03/14': 'رحلت امام خمینی',
  '03/15': 'قیام ۱۵ خرداد',
  '11/22': 'پیروزی انقلاب اسلامی',
  '12/29': 'ملی شدن صنعت نفت',
};
function mock(date: string): OfficialAnswer {
  const title = MOCK[jalaliText(date).slice(5)] ?? (isFriday(date) ? 'جمعه' : null);
  return { isHoliday: !!title, title, raw: { mock: true } };
}

export function officialCalendarEnabled() {
  return config.holidayProvider !== 'none';
}

/** Asks the web service directly (used by the admin's connection test). */
export async function askOfficial(date: string): Promise<OfficialAnswer> {
  if (config.holidayProvider === 'sapi') return sapi(date);
  if (config.holidayProvider === 'mock') return mock(date);
  throw new HttpError(503, 'holiday_disabled', 'سرویس تقویم رسمی فعال نشده است');
}

const FRESH_DAYS = 30;

/** Official answer for each day, from the cache or the web service; days the service cannot answer are left out. */
async function official(dates: string[]): Promise<Map<string, OfficialAnswer>> {
  const out = new Map<string, OfficialAnswer>();
  if (!officialCalendarEnabled() || !dates.length) return out;
  const cached = await query<{ date: string; is_holiday: boolean; title: string | null }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, is_holiday, title FROM holiday_lookups
      WHERE date = ANY($1::date[]) AND checked_at > now() - make_interval(days => $2)`,
    [dates, FRESH_DAYS],
  );
  for (const r of cached) out.set(r.date, { isHoliday: r.is_holiday, title: r.title });
  const missing = dates.filter((d) => !out.has(d));
  // A few requests at a time; one failure (e.g. the service is down) stops asking for the rest.
  let failed = false;
  for (let i = 0; i < missing.length && !failed; i += 4) {
    await Promise.all(
      missing.slice(i, i + 4).map(async (d) => {
        try {
          const a = await askOfficial(d);
          out.set(d, a);
          await query(
            `INSERT INTO holiday_lookups (date, is_holiday, title) VALUES ($1, $2, $3)
             ON CONFLICT (date) DO UPDATE SET is_holiday = EXCLUDED.is_holiday, title = EXCLUDED.title, checked_at = now()`,
            [d, a.isHoliday, a.title],
          );
        } catch (e) {
          failed = true;
          logger.warn({ date: d, err: (e as Error).message }, 'official holiday lookup failed');
        }
      }),
    );
  }
  return out;
}

const MAX_DAYS = 62;

/** Holidays between two days (inclusive) as seen by a chamber (null: nationwide only). */
export async function holidaysBetween(chamberId: string | null, from: string, to: string): Promise<Holiday[]> {
  const dates: string[] = [];
  const [y, m, d0] = parts(from);
  for (let t = Date.UTC(y, m - 1, d0); dates.length < MAX_DAYS; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > to) break;
    dates.push(d);
  }
  const defined = await query<{ id: string; date: string; title: string; chamber_id: string | null }>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, title, chamber_id FROM holidays
      WHERE date BETWEEN $1 AND $2 AND (chamber_id IS NULL OR chamber_id = $3) ORDER BY chamber_id NULLS FIRST`,
    [from, to, chamberId],
  );
  const off = await official(dates);
  const result: Holiday[] = [];
  for (const d of dates) {
    const mine = defined.filter((h) => h.date === d);
    const o = off.get(d);
    const titles: string[] = [];
    let source: Holiday['source'] | null = null;
    for (const h of mine) {
      titles.push(h.title);
      source ??= h.chamber_id ? 'chamber' : 'national';
    }
    if (o?.isHoliday && o.title !== 'جمعه') {
      if (o.title) titles.push(o.title);
      source ??= 'official';
    }
    if (isFriday(d)) {
      titles.push('جمعه');
      source ??= 'friday';
    }
    if (o?.isHoliday && !titles.length) titles.push('تعطیل رسمی');
    if (source || o?.isHoliday) result.push({ date: d, title: [...new Set(titles)].join('، '), source: source ?? 'official', id: mine[0]?.id });
  }
  return result;
}

/** The holiday on the day of this instant, if any. */
export async function holidayOn(chamberId: string, at: Date): Promise<Holiday | null> {
  const d = tehranDate(at);
  return (await holidaysBetween(chamberId, d, d))[0] ?? null;
}

/** «۲ فروردین ۱۴۰۵» for messages. */
export function jalaliLabel(date: string) {
  const [jy, jm, jd] = toJalali(...parts(date));
  return toPersianDigits(`${jd} ${JALALI_MONTHS[jm - 1]} ${jy}`);
}
