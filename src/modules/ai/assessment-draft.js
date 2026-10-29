// Assessment draft for the physician ("A" of the visit summary), built by rules from what the
// system recorded: complaints and urgency from triage, abnormal vital signs and lab values, chest
// X-ray flags, background (allergies, chronic conditions) and ICD-10 candidates for the complaints.
// It lists findings and *problems to consider*; it never states a diagnosis. The physician edits
// it; it reaches the patient only through the physician-approved summary.
import { reviewLabRows } from './lab-review.js';
import { icdByCode, searchIcd } from '../rx/icd10.js';
import { normalizeFa, toFaDigits } from '../../lib/fa.js';

export const ASSESSMENT_DRAFT_VERSION = 'assessment-draft-2026.10.1';
export const DRAFT_HEADER = 'پیشنهاد دستیار — نیازمند بررسی پزشک';

const URGENCY_FA = { self_care: 'مراقبت در منزل', routine: 'غیرفوری', urgent: 'نیازمند ویزیت در اولین فرصت', emergency: 'اورژانسی' };
const CXR_FA = {
  Atelectasis: 'آتلکتازی', Consolidation: 'کانسالیدیشن', Infiltration: 'ارتشاح', Pneumothorax: 'پنوموتوراکس', Edema: 'ادم ریوی',
  Emphysema: 'آمفیزم', Fibrosis: 'فیبروز', Effusion: 'افیوژن پلور', Pneumonia: 'الگوی پنومونی', Pleural_Thickening: 'ضخیم‌شدگی پلور',
  Cardiomegaly: 'بزرگی سایه قلب', Nodule: 'ندول', Mass: 'توده', 'Lung Lesion': 'ضایعه ریوی', Fracture: 'شکستگی', 'Lung Opacity': 'کدورت ریوی',
  'Enlarged Cardiomediastinum': 'پهن‌شدگی مدیاستن',
};
// Abnormal finding → ICD-10 code to *consider* (only codes present in the ICD list are offered).
const LAB_ICD = { 'hb:low': 'D64.9', 'fbs:high': 'E11.9', 'ldl:high': 'E78.5', 'tsh:high': 'E03.9', 'tsh:low': 'E05.9' };
const CXR_ICD = { Pneumonia: 'J18.9', Consolidation: 'J18.9', Cardiomegaly: 'I50.9', Edema: 'I50.9' };
const bullets = (xs) => xs.map((x) => `• ${x}`).join('\n');
const sub = (xs) => xs.map((x) => `   ◦ ${x}`).join('\n');

// The structured triage form writes "برای: … محل: … علائم: … مدت: …"; the complaint is in
// «محل» and «علائم» (and the patient's own «توضیح»). Free text is used as is.
const FORM_LABEL = /(برای|محل|علائم حیاتی|علائم|شدت درد|شروع|مدت|پاسخ مثبت|توضیح)\s*:/g;
export function complaintParts(text) {
  const t = String(text ?? '');
  if (!/(محل|علائم)\s*:/.test(t)) return [t.trim()].filter(Boolean);
  const out = [];
  const marks = [...t.matchAll(FORM_LABEL)];
  marks.forEach((m, i) => {
    if (!['محل', 'علائم', 'توضیح'].includes(m[1])) return;
    const seg = t.slice(m.index + m[0].length, marks[i + 1]?.index ?? t.length).replace(/[|—]+\s*$/, '').trim();
    if (seg) out.push(seg);
  });
  return out;
}

// ICD-10 codes for complaint words, strictly: the complaint word must appear in the code's
// Persian label as a whole word («تب» → «تب، نامشخص», never «تبخال»).
export function icdForComplaints(complaints) {
  const out = [];
  const terms = complaints.flatMap(complaintParts).flatMap((c) => normalizeFa(c).split(/[،,؛;\-–/]| و /)).map((x) => x.trim()).filter((x) => x.length >= 2);
  for (const term of [...new Set(terms)].slice(0, 8)) {
    const re = new RegExp(`(^|[\\s،(])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s،)])`);
    const hit = searchIcd(term, 5).find((x) => re.test(normalizeFa(x.label_fa)));
    if (hit && !out.some((x) => x.code === hit.code)) out.push(hit);
  }
  return out.slice(0, 4);
}

/**
 * facts: { patient, triage, records, cxr: [{ key, tier }] }
 * → { text, icd: [{ code, label_fa, reason }], basis: [...], version }
 */
export function buildAssessmentDraft(facts) {
  const { patient = {}, triage = null, records = [], cxr = [] } = facts;
  const findings = [];
  const consider = new Map(); // code → reason
  const add = (code, reason) => { if (icdByCode(code) && !consider.has(code)) consider.set(code, reason); };
  const basis = [];

  // Complaints and urgency (triage).
  const complaints = (triage?.symptoms ?? []).map((x) => x.name).filter(Boolean);
  if (complaints.length) {
    basis.push('triage');
    findings.push(`شکایت اصلی: ${complaints.flatMap(complaintParts).slice(0, 4).join('، ').slice(0, 300)}`);
    for (const c of icdForComplaints(complaints)) add(c.code, 'بر اساس شکایت بیمار');
  }
  if (triage?.urgency_level) findings.push(`سطح فوریت در ارزیابی اولیه سامانه: ${URGENCY_FA[triage.urgency_level] ?? triage.urgency_level}`);
  if (triage?.red_flags?.length) findings.push(`⚠️ علائم هشدار گزارش‌شده: ${triage.red_flags.join('، ')}`);

  // Vital signs reported by the patient.
  const v = (triage?.symptoms ?? []).map((x) => x.form?.vitals).find((x) => x && Object.keys(x).length);
  if (v) {
    basis.push('vitals');
    const ab = [];
    if (v.temp_c != null && v.temp_c >= 38) { ab.push(`تب ${v.temp_c}°C`); add('R50.9', 'دمای ۳۸ درجه یا بیشتر'); }
    if (v.spo2 != null && v.spo2 < 94) { ab.push(`SpO₂ ${v.spo2}٪ (پایین)`); add('R06.0', 'اشباع اکسیژن پایین'); }
    if (v.sys != null && (v.sys >= 140 || (v.dia ?? 0) >= 90)) { ab.push(`فشار ${v.sys}/${v.dia ?? '?'} (بالا)`); add('I10', 'فشار خون اندازه‌گیری‌شده بالا (یک بار؛ نیاز به تکرار)'); }
    if (v.sys != null && v.sys < 90) ab.push(`فشار ${v.sys}/${v.dia ?? '?'} (پایین)`);
    if (v.hr != null && (v.hr > 100 || v.hr < 50)) ab.push(`ضربان ${v.hr}/دقیقه (${v.hr > 100 ? 'تند' : 'کند'})`);
    findings.push(ab.length ? `علائم حیاتی غیرطبیعی (اندازه‌گیری توسط بیمار): ${ab.join('، ')}` : 'علائم حیاتی گزارش‌شده در محدوده طبیعی');
  }

  // Lab values outside the reference range.
  const labs = [];
  for (const r of records) {
    if (!r.lab_rows?.length) continue;
    for (const f of reviewLabRows(r.lab_rows, { sex: patient.gender })) {
      if (f.status === 'normal' || f.status === 'unknown') continue;
      labs.push(`${f.name} ${f.value}${f.unit ? ` ${f.unit}` : ''} — ${f.status === 'critical' ? '⚠️ بحرانی' : f.dir === 'low' ? 'پایین' : 'بالا'}${f.range ? ` (مرجع ${f.range})` : ''}`);
      if (f.key && f.dir) add(LAB_ICD[`${f.key}:${f.dir}`], `آزمایش: ${f.name} ${f.dir === 'low' ? 'پایین' : 'بالا'}`);
    }
  }
  if (labs.length) { basis.push('labs'); findings.push(`آزمایش‌های خارج از محدوده:\n${sub(labs)}`); }

  // Chest X-ray pattern flags (research aid).
  const flagged = cxr.filter((x) => x.tier === 'strong' || x.tier === 'moderate');
  if (flagged.length) {
    basis.push('cxr');
    findings.push(`الگوهای علامت‌خورده در رادیوگرافی قفسه سینه (ابزار کمکی، نه تشخیص): ${flagged.map((x) => `${CXR_FA[x.key] ?? x.key}${x.tier === 'strong' ? ' (قوی)' : ''}`).join('، ')}`);
    for (const x of flagged) add(CXR_ICD[x.key], `رادیوگرافی: ${CXR_FA[x.key] ?? x.key}`);
  }

  // Background to keep in mind.
  const bg = [];
  if (patient.allergies?.length) bg.push(`حساسیت: ${patient.allergies.join('، ')}`);
  if (patient.chronic_conditions?.length) bg.push(`بیماری زمینه‌ای: ${patient.chronic_conditions.join('، ')}`);
  if (patient.age != null && (patient.age >= 65 || patient.age < 5)) bg.push(`سن ${toFaDigits(patient.age)} سال (گروه پرخطر)`);

  const icd = [...consider].map(([code, reason]) => ({ code, label_fa: icdByCode(code).label_fa, reason })).slice(0, 6);
  const parts = [`[${DRAFT_HEADER}]`];
  parts.push(findings.length ? `یافته‌ها:\n${bullets(findings)}` : 'یافته‌ها: داده‌ای از تریاژ، علائم حیاتی، آزمایش یا رادیوگرافی برای این ویزیت ثبت نشده است.');
  if (icd.length) parts.push(`موارد مطرح برای بررسی (تأیید یا رد با پزشک):\n${bullets(icd.map((x) => `${x.code} ${x.label_fa} — ${x.reason}`))}`);
  if (bg.length) parts.push(`در نظر داشته باشید:\n${bullets(bg)}`);
  parts.push('ارزیابی و تشخیص نهایی پزشک: …');
  return { text: parts.join('\n\n'), icd, basis, version: ASSESSMENT_DRAFT_VERSION };
}
