/**
 * Jalali (Solar Hijri) ↔ Gregorian conversion without Intl calendar support,
 * so it also works on Hermes (React Native).
 */

const G_DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

export function toJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    355666 +
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) +
    gd +
    G_DAYS_BEFORE_MONTH[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

export function toGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days =
    -355668 +
    365 * jy +
    Math.floor(jy / 33) * 8 +
    Math.floor(((jy % 33) + 3) / 4) +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  for (gm = 0; gm < 13 && gd > monthDays[gm]; gm++) gd -= monthDays[gm];
  return [gy, gm, gd];
}

export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  // Esfand: 30 days in leap years. A year is leap if 1 Farvardin of next year is 366 days later.
  const [gy, gm, gd] = toGregorian(jy + 1, 1, 1);
  const [gy0, gm0, gd0] = toGregorian(jy, 1, 1);
  const diff = (Date.UTC(gy, gm - 1, gd) - Date.UTC(gy0, gm0 - 1, gd0)) / 86400000;
  return diff === 366 ? 30 : 29;
}

export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

export const WEEKDAYS_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toPersianDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

export function toLatinDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

const pad = (n: number) => String(n).padStart(2, '0');

function asDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** ۱۴۰۵/۰۷/۱۴ (in the device's local timezone). */
export function formatJalaliDate(value: Date | string | number, persianDigits = true): string {
  const d = asDate(value);
  const [jy, jm, jd] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const s = `${jy}/${pad(jm)}/${pad(jd)}`;
  return persianDigits ? toPersianDigits(s) : s;
}

/** سه‌شنبه ۱۴ مهر ۱۴۰۵ */
export function formatJalaliLong(value: Date | string | number): string {
  const d = asDate(value);
  const [jy, jm, jd] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return toPersianDigits(`${WEEKDAYS_FA[d.getDay()]} ${jd} ${JALALI_MONTHS[jm - 1]} ${jy}`);
}

export function formatTime(value: Date | string | number): string {
  const d = asDate(value);
  return toPersianDigits(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

export function formatJalaliDateTime(value: Date | string | number): string {
  return `${formatJalaliDate(value)} - ساعت ${formatTime(value)}`;
}

/** Parse "1405/07/14" (+ optional "HH:mm") as local time. Returns null if invalid. */
export function parseJalali(date: string, time = '00:00'): Date | null {
  const m = toLatinDigits(date.trim()).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  const t = toLatinDigits(time.trim()).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const [jy, jm, jd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (jm < 1 || jm > 12 || jd < 1 || jd > jalaliMonthLength(jy, jm)) return null;
  const [h, min] = [Number(t[1]), Number(t[2])];
  if (h > 23 || min > 59) return null;
  const [gy, gm, gd] = toGregorian(jy, jm, jd);
  return new Date(gy, gm - 1, gd, h, min);
}
