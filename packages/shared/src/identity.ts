import { toLatinDigits } from './jalali.js';

/** Validates an Iranian national code (کد ملی) with its check digit. */
export function isValidNationalCode(input: string): boolean {
  const code = toLatinDigits(input.trim());
  if (!/^\d{10}$/.test(code)) return false;
  if (/^(\d)\1{9}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const sum = digits.slice(0, 9).reduce((acc, d, i) => acc + d * (10 - i), 0);
  const r = sum % 11;
  const check = digits[9];
  return r < 2 ? check === r : check === 11 - r;
}

export function normalizeNationalCode(input: string): string {
  return toLatinDigits(input.trim()).replace(/\D/g, '');
}
