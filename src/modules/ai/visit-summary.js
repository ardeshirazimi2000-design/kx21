// Visit summary draft (SOAP) built from what the system already recorded: triage, patient
// profile, documents and lab values, the in-visit chat, prescriptions. Deterministic and
// versioned; an optional self-hosted LLM may only rephrase the *subjective* part.
// The assessment (A) is never generated — it is the physician's.
import { reviewLabRows } from './lab-review.js';

export const SUMMARY_VERSION = 'visit-summary-2026.10.1';

const URGENCY_FA = { self_care: 'مراقبت در منزل', routine: 'غیرفوری', urgent: 'نیازمند ویزیت در اولین فرصت', emergency: 'اورژانسی' };
const CHANNEL_FA = { video: 'تصویری', audio: 'صوتی', chat: 'متنی' };
const GENDER_FA = { female: 'زن', male: 'مرد', other: 'سایر' };
const STATUS_FA = { low: 'پایین', high: 'بالا', critical: '⚠️ بحرانی', unknown: 'بدون محدوده' };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const bullets = (items) => items.filter(Boolean).map((x) => `• ${x}`).join('\n');

export function ageFrom(dob, at = new Date()) {
  if (!dob) return null;
  const d = new Date(dob);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  if (at.getUTCMonth() < d.getUTCMonth() || (at.getUTCMonth() === d.getUTCMonth() && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

const drugLine = (d) => [d.name, d.dose, d.frequency, d.duration && `به مدت ${d.duration}`, d.instructions].filter(Boolean).join(' — ');

/**
 * facts: { visit, patient, triage, messages, records, prescriptions }
 * → { subjective, objective, plan, advice, complaint, patient_summary, sources }
 */
export function buildVisitSummary(facts) {
  const { visit = {}, patient = {}, triage = null, messages = [], records = [], prescriptions = [] } = facts;
  const sources = [];

  // ---- S: why the patient came, in their own words
  const s = [];
  const complaint = triage?.symptoms?.map((x) => x.name).filter(Boolean).join('\n')
    || messages.find((m) => m.sender_role === 'patient')?.content || '';
  if (complaint) {
    s.push(`شکایت / دلیل مراجعه:\n${clip(complaint, 700).replace(/ (?=(محل|علائم|شدت|شروع|مدت|پاسخ مثبت|علائم حیاتی|توضیح):)/g, '\n')}`);
  }
  if (triage) {
    sources.push('triage');
    s.push(`ارزیابی اولیه سامانه (${triage.rule_version ?? 'قواعد'}): ${URGENCY_FA[triage.urgency_level] ?? triage.urgency_level}`
      + `${triage.red_flags?.length ? ` — هشدارها: ${triage.red_flags.join('، ')}` : ''}`);
  }
  const bg = [];
  if (patient.age != null) bg.push(`${patient.age} ساله`);
  if (patient.gender) bg.push(GENDER_FA[patient.gender] ?? patient.gender);
  bg.push(`حساسیت: ${patient.allergies?.length ? patient.allergies.join('، ') : 'ذکر نشده'}`);
  bg.push(`بیماری زمینه‌ای: ${patient.chronic_conditions?.length ? patient.chronic_conditions.join('، ') : 'ذکر نشده'}`);
  s.push(`سابقه: ${bg.join(' · ')}`);
  const said = messages.filter((m) => m.sender_role === 'patient').slice(0, 8).map((m) => clip(m.content, 220));
  if (said.length) { sources.push('chat'); s.push(`گفته‌های بیمار در گفتگوی ویزیت:\n${bullets(said)}`); }
  const notes = records.filter((r) => r.note).map((r) => `${r.title}: ${clip(r.note, 200)}`);
  if (notes.length) s.push(`توضیحات بیمار همراه مدارک:\n${bullets(notes)}`);

  // ---- O: measured / documented findings
  const o = [];
  const vitals = triage?.symptoms?.map((x) => x.form?.vitals).find((v) => v && Object.keys(v).length);
  if (vitals) {
    const src = triage.symptoms.find((x) => x.form?.vitals_source)?.form.vitals_source;
    const v = [];
    if (vitals.temp_c != null) v.push(`دما ${vitals.temp_c}°C`);
    if (vitals.spo2 != null) v.push(`SpO₂ ${vitals.spo2}٪`);
    if (vitals.sys != null) v.push(`فشار ${vitals.sys}/${vitals.dia ?? '?'} mmHg`);
    if (vitals.hr != null) v.push(`ضربان ${vitals.hr}/دقیقه`);
    o.push(`علائم حیاتی (اندازه‌گیری توسط بیمار${src ? ` با «${src.device}»` : ''}): ${v.join('، ')}${src?.irregular_pulse ? ' — ضربان نامنظم گزارش‌شده' : ''}`);
  }
  for (const r of records) {
    sources.push(`record:${r.id ?? r.title}`);
    const head = `${r.category_label}: ${r.title}${r.file_count ? ` (${r.file_count} فایل)` : ''}`;
    const lines = [];
    if (r.lab_rows?.length) {
      const f = reviewLabRows(r.lab_rows, { sex: patient.gender });
      const abnormal = f.filter((x) => x.status !== 'normal');
      for (const x of abnormal) lines.push(`${x.name}: ${x.value}${x.unit ? ` ${x.unit}` : ''} (${STATUS_FA[x.status]}${x.range ? `، مرجع ${x.range}` : ''})`);
      const normal = f.length - abnormal.length;
      if (normal) lines.push(`${normal} مقدار دیگر در محدوده مرجع`);
      if (r.lab_rows.some((x) => x.ocr)) lines.push('بخشی از مقادیر خودکار از عکس برگه خوانده و توسط بیمار تأیید شده است');
    }
    if (r.doctor_opinion) lines.push(`نظر پزشک: ${clip(r.doctor_opinion, 300)}`);
    o.push(lines.length ? `${head}\n${bullets(lines)}` : head);
  }
  if (!o.length) o.push('یافته ثبت‌شده‌ای (علائم حیاتی، آزمایش یا مدرک) برای این ویزیت وجود ندارد.');

  // ---- P: what was prescribed and advised
  const p = [];
  for (const rx of prescriptions) {
    sources.push(`prescription:${rx.id ?? ''}`);
    const tag = rx.status === 'issued' ? 'نسخه صادرشده' : 'پیش‌نویس نسخه (هنوز امضا نشده)';
    p.push(`${tag}:\n${bullets(rx.drugs.map(drugLine))}${rx.notes ? `\nتوضیح نسخه: ${clip(rx.notes, 300)}` : ''}`);
  }
  // Recommendations: the physician's own words from the visit chat (editable before sending).
  const advice = bullets(messages.filter((m) => m.sender_role === 'doctor').slice(-6).map((m) => clip(m.content, 220)));

  const subjective = s.join('\n\n');
  const objective = o.join('\n\n');
  const plan = p.join('\n\n');
  return {
    subjective, objective, plan, advice, complaint,
    patient_summary: buildPatientSummary({ visit, complaint, prescriptions, advice }),
    sources: [...new Set(sources)],
  };
}

// Plain-language summary for the patient, from the physician-approved fields.
export function buildPatientSummary({ visit = {}, complaint = '', prescriptions = [], advice = '', followUp = '', assessmentForPatient = '' }) {
  const parts = [];
  parts.push(`خلاصه ویزیت ${CHANNEL_FA[visit.channel] ?? ''} شما${visit.doctor_name ? ` با ${visit.doctor_name}` : ''}${visit.date_fa ? ` در ${visit.date_fa}` : ''}`.replace(/\s+/g, ' '));
  const reason = String(complaint).split('\n').find((l) => l.trim() && !/^برای:/.test(l)) ?? '';
  if (reason) parts.push(`دلیل مراجعه: ${clip(reason.replace(/^(علائم|محل|توضیح):\s*/, ''), 200)}`);
  if (assessmentForPatient) parts.push(`توضیح پزشک:\n${assessmentForPatient}`);
  const issued = prescriptions.filter((r) => r.status === 'issued');
  if (issued.length) parts.push(`داروهای تجویزشده (طبق نسخه الکترونیک):\n${bullets(issued.flatMap((r) => r.drugs.map(drugLine)))}`);
  if (advice) parts.push(`توصیه‌های پزشک:\n${advice}`);
  if (followUp) parts.push(`پیگیری: ${followUp}`);
  parts.push('اگر علائم شدیدتر شد یا علامت تازه‌ای پیدا کردید (مثل تنگی نفس، درد قفسه سینه، کاهش هوشیاری یا خونریزی)، فوراً با اورژانس ۱۱۵ تماس بگیرید یا به نزدیک‌ترین مرکز درمانی مراجعه کنید.');
  return parts.join('\n\n');
}
