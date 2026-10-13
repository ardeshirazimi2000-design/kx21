// Draft review of lab results for the PHYSICIAN (never shown to the patient as-is).
// Values are compared with the lab's own reference range when the patient typed it, otherwise
// with common adult reference ranges. Ranges differ by lab, age, sex and method — the output is
// a checklist to speed up the doctor's reading, not an interpretation.
import { normalizeFa } from '../../lib/fa.js';

export const LAB_REVIEW_VERSION = 'lab-ranges-2026.10.1';

// [id, aliases, unit, low, high, {female:[lo,hi]}]
const RANGES = [
  ['hb', ['hb', 'hgb', 'hemoglobin', 'هموگلوبین'], 'g/dL', 13.5, 17.5, { female: [12, 15.5] }],
  ['wbc', ['wbc', 'گلبول سفید'], '10^3/µL', 4, 11],
  ['plt', ['plt', 'platelet', 'platelets', 'پلاکت'], '10^3/µL', 150, 450],
  ['fbs', ['fbs', 'fasting blood sugar', 'قند ناشتا', 'قند خون ناشتا', 'glucose fasting'], 'mg/dL', 70, 99],
  ['hba1c', ['hba1c', 'a1c', 'هموگلوبین a1c'], '%', 4, 5.6],
  ['chol', ['cholesterol', 'chol', 'کلسترول', 'total cholesterol'], 'mg/dL', 0, 199],
  ['ldl', ['ldl'], 'mg/dL', 0, 99],
  ['hdl', ['hdl'], 'mg/dL', 40, 1000, { female: [50, 1000] }],
  ['tg', ['tg', 'triglyceride', 'triglycerides', 'تری گلیسرید'], 'mg/dL', 0, 149],
  ['cr', ['cr', 'creatinine', 'کراتینین'], 'mg/dL', 0.7, 1.3, { female: [0.6, 1.1] }],
  ['bun', ['bun', 'urea', 'اوره'], 'mg/dL', 7, 20],
  ['tsh', ['tsh'], 'mIU/L', 0.4, 4.0],
  ['alt', ['alt', 'sgpt'], 'U/L', 7, 55],
  ['ast', ['ast', 'sgot'], 'U/L', 8, 48],
  ['na', ['na', 'sodium', 'سدیم'], 'mmol/L', 135, 145],
  ['k', ['k', 'potassium', 'پتاسیم'], 'mmol/L', 3.5, 5.1],
  ['vitd', ['vit d', 'vitamin d', '25-oh vit d', 'ویتامین d', 'ویتامین دی'], 'ng/mL', 30, 100],
  ['ferritin', ['ferritin', 'فریتین'], 'ng/mL', 24, 336, { female: [11, 307] }],
  ['crp', ['crp'], 'mg/L', 0, 10],
  ['esr', ['esr'], 'mm/h', 0, 20, { female: [0, 30] }],
];
const index = new Map();
for (const r of RANGES) for (const a of r[1]) index.set(normalizeFa(a), r);

// Critical values worth calling out immediately (common critical-value lists).
const CRITICAL = { hb: [7, 20], k: [2.8, 6.2], na: [120, 160], fbs: [40, 400], plt: [20, 1000], wbc: [2, 30] };

function parseRange(s) {
  const m = String(s ?? '').replace(/[٫]/g, '.').match(/(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** rows: [{ name, value, unit?, ref? }] → findings for the doctor */
export function reviewLabRows(rows, { sex } = {}) {
  const findings = [];
  for (const row of rows ?? []) {
    const value = Number(String(row.value ?? '').replace(/[٫,]/g, '.').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    if (!Number.isFinite(value)) continue;
    const known = index.get(normalizeFa(row.name ?? ''));
    let range = parseRange(row.ref);
    let source = 'lab';
    if (!range && known) {
      range = sex === 'female' && known[5]?.female ? known[5].female : [known[3], known[4]];
      source = 'default';
    }
    if (!range) { findings.push({ name: row.name, value, status: 'unknown', note: 'محدوده مرجع نامشخص' }); continue; }
    const [lo, hi] = range;
    let status = value < lo ? 'low' : value > hi ? 'high' : 'normal';
    const crit = known && CRITICAL[known[0]];
    if (crit && (value < crit[0] || value > crit[1])) status = 'critical';
    findings.push({ name: row.name, value, unit: row.unit || known?.[2] || '', range: `${lo}–${hi}`, range_source: source, status });
  }
  return findings;
}

export function summarizeFindings(findings) {
  const label = { low: 'پایین‌تر از محدوده', high: 'بالاتر از محدوده', critical: '⚠️ مقدار بحرانی', normal: 'در محدوده', unknown: 'بدون محدوده مرجع' };
  const abnormal = findings.filter((f) => f.status !== 'normal');
  const lines = findings.map((f) => `• ${f.name}: ${f.value}${f.unit ? ` ${f.unit}` : ''} — ${label[f.status]}${f.range ? ` (مرجع ${f.range}${f.range_source === 'default' ? '، عمومی' : ''})` : ''}`);
  const head = abnormal.length
    ? `${abnormal.length} مورد خارج از محدوده یا نیازمند توجه است${findings.some((f) => f.status === 'critical') ? '؛ مقدار بحرانی وجود دارد.' : '.'}`
    : 'همه مقادیر واردشده در محدوده مرجع هستند.';
  return `${head}\n${lines.join('\n')}`;
}
