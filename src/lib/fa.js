// Persian text helpers used by the rule engines (normalisation before keyword matching).
const DIGITS = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

export function normalizeFa(text) {
  return String(text ?? '')
    .replace(/[۰-۹٠-٩]/g, (d) => DIGITS[d])
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه').replace(/[أإآ]/g, 'ا')
    .replace(/[ً-ٰٟ]/g, '') // harakat
    .replace(/‌|‏|‎/g, ' ') // ZWNJ & bidi marks
    .replace(/ـ/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ه ی(?= )/g, 'ه') // ezafe written as a separate "ی": "قفسه‌ی سینه" → "قفسه سینه"
    .trim();
}

export const toFaDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

// Accepts 09xxxxxxxxx, +989xxxxxxxxx, 00989..., Persian digits.
export function normalizePhone(p) {
  let s = normalizeFa(p).replace(/[\s-]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  return /^09\d{9}$/.test(s) ? s : null;
}

// Iranian national ID checksum.
export function isValidNationalId(id) {
  const s = normalizeFa(id);
  if (!/^\d{10}$/.test(s) || /^(\d)\1{9}$/.test(s)) return false;
  const sum = [...s.slice(0, 9)].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0) % 11;
  const check = Number(s[9]);
  return sum < 2 ? check === sum : check === 11 - sum;
}

const FA_DATE = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});
export const formatFaDateTime = (iso) => FA_DATE.format(new Date(iso));
