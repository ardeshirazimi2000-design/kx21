// Draft review of lab results for the PHYSICIAN (never shown to the patient as-is).
// Values are compared with the lab's own reference range when the patient typed it, otherwise
// with common adult reference ranges. Ranges differ by lab, age, sex and method — the output is
// a checklist to speed up the doctor's reading, not an interpretation.
import { normalizeFa } from '../../lib/fa.js';

export const LAB_REVIEW_VERSION = 'lab-ranges-2026.10.1';

// [id, aliases, unit, low, high, {female:[lo,hi]}]
const RANGES = [
  ['hb', ['hb', 'hgb', 'hemoglobin', 'haemoglobin', 'هموگلوبین'], 'g/dL', 13.5, 17.5, { female: [12, 15.5] }],
  ['wbc', ['wbc', 'white blood cells', 'white blood cell', 'leukocytes', 'گلبول سفید'], '10^3/µL', 4, 11],
  ['plt', ['plt', 'platelet', 'platelets', 'platelet count', 'پلاکت'], '10^3/µL', 150, 450],
  ['fbs', ['fbs', 'fasting blood sugar', 'blood sugar fasting', 'fasting glucose', 'glucose fasting', 'glucose (fasting)', 'قند ناشتا', 'قند خون ناشتا'], 'mg/dL', 70, 99],
  ['hba1c', ['hba1c', 'hb a1c', 'hbaic', 'hbalc', 'hba1 c', 'a1c', 'glycated hemoglobin', 'هموگلوبین a1c'], '%', 4, 5.6],
  ['chol', ['cholesterol', 'chol', 'total cholesterol', 'cholesterol total', 'کلسترول'], 'mg/dL', 0, 199],
  ['ldl', ['ldl', 'ldl-c', 'ldl cholesterol', 'ldl-cholesterol'], 'mg/dL', 0, 99],
  ['hdl', ['hdl', 'hdl-c', 'hdl cholesterol', 'hdl-cholesterol'], 'mg/dL', 40, 1000, { female: [50, 1000] }],
  ['tg', ['tg', 'triglyceride', 'triglycerides', 'تری گلیسرید'], 'mg/dL', 0, 149],
  ['cr', ['cr', 'creatinine', 'creatinine (serum)', 'کراتینین'], 'mg/dL', 0.7, 1.3, { female: [0.6, 1.1] }],
  ['bun', ['bun', 'blood urea nitrogen', 'urea', 'اوره'], 'mg/dL', 7, 20],
  ['tsh', ['tsh', 't.s.h'], 'mIU/L', 0.4, 4.0],
  ['alt', ['alt', 'sgpt', 'alt (sgpt)', 'sgpt (alt)'], 'U/L', 7, 55],
  ['ast', ['ast', 'sgot', 'ast (sgot)', 'sgot (ast)'], 'U/L', 8, 48],
  ['na', ['na', 'sodium', 'سدیم'], 'mmol/L', 135, 145],
  ['k', ['k', 'potassium', 'پتاسیم'], 'mmol/L', 3.5, 5.1],
  ['vitd', ['vit d', 'vitamin d', 'vitamin d3', '25-oh vit d', '25-oh vitamin d', '25(oh) vitamin d', '25 oh vitamin d', 'ویتامین d', 'ویتامین دی'], 'ng/mL', 30, 100],
  ['ferritin', ['ferritin', 'فریتین'], 'ng/mL', 24, 336, { female: [11, 307] }],
  ['crp', ['crp'], 'mg/L', 0, 10],
  ['esr', ['esr'], 'mm/h', 0, 20, { female: [0, 30] }],
];
const index = new Map();
for (const r of RANGES) for (const a of r[1]) index.set(normalizeFa(a), r);
// Longest alias first, so "hdl cholesterol" wins over "cholesterol" and "ldl-c" over "ldl".
const ALIASES = [...index.keys()].sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALIAS_RES = ALIASES.map((a) => [a, new RegExp(`(^|[^a-z0-9])${esc(a)}(?![a-z0-9])`)]);

/** Finds a known test name in a (normalized) line; returns { id, alias, index, end, unit } or null. */
export function matchTest(line) {
  let best = null;
  for (const [alias, re] of ALIAS_RES) {
    const m = re.exec(line);
    if (!m) continue;
    const index = m.index + m[1].length;
    if (!best || index < best.index || (index === best.index && alias.length > best.alias.length)) {
      const r = index_(alias);
      best = { id: r[0], alias, index, end: index + alias.length, unit: r[2] };
    }
  }
  return best;
}
const index_ = (alias) => index.get(alias);
export const knownTest = (name) => index.get(normalizeFa(name ?? ''));

// Critical values worth calling out immediately (common critical-value lists).
const CRITICAL = { hb: [7, 20], k: [2.8, 6.2], na: [120, 160], fbs: [40, 400], plt: [20, 1000], wbc: [2, 30] };

export function parseRange(s) {
  const t = normalizeFa(s).replace(/[٫]/g, '.').replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2'); // "4,2" decimal comma
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*(?:[-–—~]|to|تا)\s*(-?\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2])];
  const lt = t.match(/(?:<|≤|=<|less than|up to|upto|کمتر از|تا)\s*(\d+(?:\.\d+)?)/);
  if (lt) return [0, Number(lt[1])];
  const gt = t.match(/(?:>|≥|>=|more than|greater than|بیشتر از)\s*(\d+(?:\.\d+)?)/);
  if (gt) return [Number(gt[1]), Infinity];
  return null;
}

/** rows: [{ name, value, unit?, ref? }] → findings for the doctor */
export function reviewLabRows(rows, { sex } = {}) {
  const findings = [];
  for (const row of rows ?? []) {
    let value = Number(String(row.value ?? '').replace(/[٫,]/g, '.').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    if (!Number.isFinite(value)) continue;
    const known = index.get(normalizeFa(row.name ?? '')) ?? (row.name && (() => { const m = matchTest(normalizeFa(row.name)); return m && index.get(m.alias); })());
    let range = parseRange(row.ref);
    // Counts printed per µL (e.g. WBC 7400, PLT 250000) vs default ranges in 10^3/µL.
    if (!range && known && ['wbc', 'plt'].includes(known[0]) && value >= 1000) { value /= 1000; }
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
    findings.push({ name: row.name, key: known?.[0] ?? null, dir: value < lo ? 'low' : value > hi ? 'high' : null, value, unit: row.unit || known?.[2] || '', range: hi === Infinity ? `>${lo}` : `${lo}–${hi}`, range_source: source, status });
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
