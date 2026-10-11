/** Iranian national code (کد ملی) checksum validation. */
export function isValidNationalCode(input: string): boolean {
  if (!/^\d{10}$/.test(input)) return false;
  if (/^(\d)\1{9}$/.test(input)) return false;
  const digits = input.split('').map(Number);
  const check = digits[9];
  const sum = digits.slice(0, 9).reduce((s, d, i) => s + d * (10 - i), 0) % 11;
  return sum < 2 ? check === sum : check === 11 - sum;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (ch) => {
    const p = PERSIAN_DIGITS.indexOf(ch);
    return String(p >= 0 ? p : ARABIC_DIGITS.indexOf(ch));
  });
}

/** Normalises +98 / 0098 / 9xx forms to the 09xxxxxxxxx format Shahkar expects; null if invalid. */
export function normalizeMobile(input: string): string | null {
  let m = toLatinDigits(input).replace(/[\s-]/g, '');
  if (m.startsWith('+98')) m = '0' + m.slice(3);
  else if (m.startsWith('0098')) m = '0' + m.slice(4);
  else if (/^9\d{9}$/.test(m)) m = '0' + m;
  return /^09\d{9}$/.test(m) ? m : null;
}

export function normalizeNationalCode(input: string): string {
  return toLatinDigits(input).replace(/[\s-]/g, '');
}

export function maskNationalCode(nc: string): string {
  return nc.length === 10 ? `${nc.slice(0, 3)}****${nc.slice(7)}` : '***';
}

export function maskMobile(m: string): string {
  return m.length === 11 ? `${m.slice(0, 4)}***${m.slice(7)}` : '***';
}
