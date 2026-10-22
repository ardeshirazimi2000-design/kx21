import { JALALI_MONTHS, toJalali, toPersianDigits } from '@kx/shared';
import { query } from '../db/pool.js';

/**
 * Holidays (تعطیلات) for the meetings calendar: Fridays and the holidays defined in the system — nationwide by
 * the Super Admin (usually a year's official holidays added from the bundled list) or for one chamber by its admin.
 */

export interface Holiday {
  date: string; // YYYY-MM-DD (Gregorian, Tehran)
  title: string;
  source: 'friday' | 'national' | 'chamber';
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
  const result: Holiday[] = [];
  for (const d of dates) {
    const mine = defined.filter((h) => h.date === d);
    const titles = mine.map((h) => h.title);
    let source: Holiday['source'] | null = mine.length ? (mine[0].chamber_id ? 'chamber' : 'national') : null;
    if (isFriday(d)) {
      titles.push('جمعه');
      source ??= 'friday';
    }
    if (source) result.push({ date: d, title: [...new Set(titles)].join('، '), source, id: mine[0]?.id });
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
