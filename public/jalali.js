// Jalali (Solar Hijri) ⇄ Gregorian conversion and a Persian date picker.
// Conversion uses the standard jalaali algorithm (Borkowski), valid for years 1–3177 SH.
// The API keeps ISO Gregorian dates; only the UI is Jalali.

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => Math.trunc(a / b);
const mod = (a, b) => a - Math.trunc(a / b) * b;

function jalCal(jy) {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i++) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn) {
  const { gy } = d2g(jdn);
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export const toJalali = (gy, gm, gd) => d2j(g2d(gy, gm, gd));
export const toGregorian = (jy, jm, jd) => d2g(j2d(jy, jm, jd));
export const isLeapJalali = (jy) => jalCal(jy).leap === 0;
export const monthLength = (jy, jm) => (jm <= 6 ? 31 : jm <= 11 ? 30 : isLeapJalali(jy) ? 30 : 29);

export const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' (Gregorian) → { jy, jm, jd }
export function isoToJalali(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return toJalali(y, m, d);
}
export function jalaliToIso(jy, jm, jd) {
  const { gy, gm, gd } = toGregorian(jy, jm, jd);
  return `${gy}-${pad(gm)}-${pad(gd)}`;
}
// "۱۴ اردیبهشت ۱۳۶۹" from a Gregorian ISO date (date only, no time zone shift).
export function formatJalaliDate(iso) {
  if (!iso) return '—';
  const { jy, jm, jd } = isoToJalali(iso);
  return `${fa(jd)} ${MONTHS[jm - 1]} ${fa(jy)}`;
}
// Today's date in Tehran as Jalali parts.
export function todayJalali() {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
  return isoToJalali(iso);
}

/**
 * Persian date picker: three selects (day / month / year). `value` and `onchange` use
 * Gregorian ISO 'YYYY-MM-DD' so the rest of the app and the API are unchanged.
 * Options: { value, minYear, maxYear, onchange, id, label }
 */
export function jalaliPicker(h, { value = null, minYear, maxYear, onchange = () => {}, id = '', label = 'تاریخ' }) {
  const t = todayJalali();
  maxYear ??= t.jy;
  minYear ??= t.jy - 120;
  let cur = value ? isoToJalali(value) : null;
  const sel = (name, extra) => h('select', { 'aria-label': `${label} — ${name}`, ...extra });
  const day = sel('روز', { id: id ? `${id}-d` : null });
  const month = sel('ماه');
  const year = sel('سال');
  day.append(h('option', { value: '' }, 'روز'));
  month.append(h('option', { value: '' }, 'ماه'), ...MONTHS.map((m, i) => h('option', { value: i + 1 }, m)));
  year.append(h('option', { value: '' }, 'سال'));
  for (let y = maxYear; y >= minYear; y--) year.append(h('option', { value: y }, fa(y)));

  const fillDays = () => {
    const y = Number(year.value) || t.jy;
    const m = Number(month.value) || 1;
    const keep = day.value;
    day.replaceChildren(h('option', { value: '' }, 'روز'));
    for (let d = 1; d <= monthLength(y, m); d++) day.append(h('option', { value: d }, fa(d)));
    if (keep && Number(keep) <= monthLength(y, m)) day.value = keep;
  };
  const emit = () => {
    fillDays();
    if (day.value && month.value && year.value) {
      cur = { jy: Number(year.value), jm: Number(month.value), jd: Number(day.value) };
      onchange(jalaliToIso(cur.jy, cur.jm, cur.jd));
    } else onchange(null);
  };
  day.onchange = emit; month.onchange = emit; year.onchange = emit;
  if (cur) { year.value = cur.jy; month.value = cur.jm; }
  fillDays();
  if (cur) day.value = cur.jd;
  return h('div', { class: 'jdate' }, day, month, year);
}
