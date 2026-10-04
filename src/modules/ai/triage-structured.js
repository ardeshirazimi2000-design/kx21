// Structured (visual) triage: body-map regions, discriminator questions, pain scale, onset,
// duration and optional self-measured vitals. Deterministic and versioned like triage.js.
//
// Clinical framing (reviewed references, not a certified protocol — needs sign-off by the
// clinical advisor before production):
//  - History structure follows SOCRATES (Site, Onset, Character, Radiation, Associated
//    symptoms, Time course, Exacerbating factors, Severity).
//  - Red-flag "discriminators" per presenting area, in the style of the Manchester Triage
//    System; stroke signs follow BE-FAST; cauda-equina, ACS, SAH ("thunderclap") and
//    anaphylaxis red flags follow common emergency-medicine teaching.
//  - Pain intensity uses the 0–10 Numeric Rating Scale (NRS-11).
//  - Safety principle: when the patient is unsure about an emergency sign, triage goes one
//    level UP (never down), and every result carries safety-netting advice.
import { RULE_VERSION as TEXT_RULE_VERSION, assess as assessText } from './triage.js';

export const STRUCTURED_RULE_VERSION = 'visual-triage-2026.10.1';

// ---------------------------------------------------------------- catalogue
// view: front/back body map; side-specific regions use the PATIENT's side.
export const REGIONS = {
  head:          { label: 'سر', view: 'both', specialty: 'neurology', group: 'head' },
  face_eyes:     { label: 'صورت و چشم', view: 'front', specialty: 'general', group: 'eye' },
  ear:           { label: 'گوش', view: 'both', specialty: 'ent', group: 'ent' },
  throat_neck:   { label: 'گلو و گردن', view: 'both', specialty: 'ent', group: 'throat' },
  chest:         { label: 'قفسه سینه', view: 'front', specialty: 'cardiology', group: 'chest' },
  abdomen_upper: { label: 'بالای شکم', view: 'front', specialty: 'gastroenterology', group: 'abdomen' },
  abdomen_lower: { label: 'پایین شکم', view: 'front', specialty: 'gastroenterology', group: 'abdomen' },
  pelvis:        { label: 'لگن و کشاله ران', view: 'front', specialty: 'general', group: 'pelvis' },
  back_upper:    { label: 'بالای کمر و پشت', view: 'back', specialty: 'orthopedics', group: 'back' },
  back_lower:    { label: 'پایین کمر', view: 'back', specialty: 'orthopedics', group: 'back' },
  arm_right:     { label: 'دست راست', view: 'both', specialty: 'orthopedics', group: 'limb_arm' },
  arm_left:      { label: 'دست چپ', view: 'both', specialty: 'orthopedics', group: 'limb_arm' },
  leg_right:     { label: 'پای راست', view: 'both', specialty: 'orthopedics', group: 'limb_leg' },
  leg_left:      { label: 'پای چپ', view: 'both', specialty: 'orthopedics', group: 'limb_leg' },
};

// Complaints that are not tied to one body area.
export const GENERAL_SYMPTOMS = {
  fever:       { label: 'تب', specialty: 'general', group: 'fever' },
  cough:       { label: 'سرفه', specialty: 'general', group: 'resp' },
  dyspnea:     { label: 'تنگی نفس', specialty: 'general', group: 'resp' },
  rash:        { label: 'بثورات یا خارش پوست', specialty: 'dermatology', group: 'skin' },
  dizziness:   { label: 'سرگیجه', specialty: 'neurology', group: 'head' },
  nausea:      { label: 'تهوع یا استفراغ', specialty: 'gastroenterology', group: 'abdomen' },
  palpitations:{ label: 'تپش قلب', specialty: 'cardiology', group: 'chest' },
  mood:        { label: 'اضطراب یا افسردگی', specialty: 'psychiatry', group: 'mood' },
  fatigue:     { label: 'خستگی و ضعف عمومی', specialty: 'general', group: 'general' },
  injury:      { label: 'آسیب یا ضربه', specialty: 'orthopedics', group: 'injury' },
};

// Discriminator questions. level: 'emergency' (red) or 'urgent' (amber) when answered yes.
// `groups` decides when the question is shown; 'always' questions are asked of everyone.
export const QUESTIONS = [
  { id: 'breathing_hard', flag: 'تنگی نفس شدید', groups: ['always'], level: 'emergency', text: 'آیا الان به‌سختی نفس می‌کشید یا نمی‌توانید جمله کامل بگویید؟' },
  { id: 'collapse', flag: 'کاهش هوشیاری یا غش', groups: ['always'], level: 'emergency', text: 'آیا بیهوش شده، غش کرده یا دچار گیجی و کاهش هوشیاری شده‌اید؟' },
  { id: 'chest_radiation', flag: 'درد سینه با انتشار به بازو، فک یا پشت', groups: ['chest'], level: 'emergency', text: 'آیا درد به بازو، فک، گردن یا پشت تیر می‌کشد؟' },
  { id: 'chest_sweat', flag: 'درد سینه همراه عرق سرد یا تهوع', groups: ['chest'], level: 'emergency', text: 'آیا همراه درد، عرق سرد، تهوع یا رنگ‌پریدگی دارید؟' },
  { id: 'chest_pressure', flag: 'درد فشارنده قفسه سینه', groups: ['chest'], level: 'emergency', text: 'آیا درد حالت فشار، سنگینی یا چنگ‌زدن روی سینه دارد؟' },
  { id: 'stroke_fast', flag: 'علائم سکته مغزی (صورت، دست، تکلم)', groups: ['head', 'limb_arm', 'limb_leg', 'eye'], level: 'emergency', text: 'آیا به‌طور ناگهانی کج‌شدن صورت، ضعف یا بی‌حسی یک طرف بدن، یا اختلال در صحبت کردن دارید؟' },
  { id: 'thunderclap', flag: 'سردرد ناگهانی و بسیار شدید', groups: ['head'], level: 'emergency', text: 'آیا سردرد ناگهانی و بدترین سردرد عمرتان است؟' },
  { id: 'meningism', flag: 'تب با خشکی گردن یا لکه‌های پوستی', groups: ['head', 'fever'], level: 'emergency', text: 'آیا همراه تب، گردن‌درد شدید با خشکی گردن یا لکه‌های پوستی که با فشار محو نمی‌شوند دارید؟' },
  { id: 'head_injury', flag: 'ضربه به سر با استفراغ یا گیجی', groups: ['head', 'injury'], level: 'emergency', text: 'آیا ضربه به سر خورده‌اید و پس از آن استفراغ، خواب‌آلودگی یا گیجی دارید؟' },
  { id: 'vision_loss', flag: 'کاهش ناگهانی بینایی یا آسیب شیمیایی چشم', groups: ['eye'], level: 'emergency', text: 'آیا بینایی‌تان ناگهان کم شده یا مواد شیمیایی به چشم‌تان پاشیده است؟' },
  { id: 'airway', flag: 'تورم لب، زبان یا گلو', groups: ['throat', 'skin'], level: 'emergency', text: 'آیا تورم لب، زبان یا گلو دارید، یا نمی‌توانید آب دهان را قورت دهید؟' },
  { id: 'gi_bleed', flag: 'استفراغ خونی یا مدفوع سیاه', groups: ['abdomen'], level: 'emergency', text: 'آیا استفراغ خونی یا مدفوع سیاه یا خونی دارید؟' },
  { id: 'rigid_abdomen', flag: 'شکم سفت و بسیار دردناک', groups: ['abdomen'], level: 'emergency', text: 'آیا شکم سفت و بسیار دردناک است، طوری که نمی‌توانید راحت حرکت کنید؟' },
  { id: 'pregnancy_pain', flag: 'درد و خونریزی در بارداری', groups: ['abdomen', 'pelvis'], level: 'emergency', text: 'آیا باردار هستید یا ممکن است باردار باشید و همراه درد، خونریزی دارید؟', when: 'may_be_pregnant' },
  { id: 'cauda_equina', flag: 'اختلال کنترل ادرار/مدفوع با کمردرد', groups: ['back'], level: 'emergency', text: 'آیا بی‌اختیاری یا احتباس ادرار و مدفوع، یا بی‌حسی در ناحیه تناسلی و نشیمنگاه دارید؟' },
  { id: 'cold_limb', flag: 'عضو سرد، رنگ‌پریده یا کبود', groups: ['limb_arm', 'limb_leg'], level: 'emergency', text: 'آیا دست یا پا سرد، رنگ‌پریده یا کبود شده است؟' },
  { id: 'self_harm', flag: 'افکار آسیب به خود', groups: ['mood'], level: 'emergency', text: 'آیا به آسیب زدن به خودتان یا پایان دادن به زندگی فکر می‌کنید؟' },
  { id: 'dvt', groups: ['limb_leg'], level: 'urgent', text: 'آیا یک پا ناگهان متورم، گرم و دردناک شده است؟' },
  { id: 'cant_bear_weight', groups: ['limb_leg', 'injury'], level: 'urgent', text: 'آیا پس از آسیب نمی‌توانید روی پا بایستید یا عضو تغییر شکل داده است؟' },
  { id: 'persistent_vomiting', groups: ['abdomen'], level: 'urgent', text: 'آیا استفراغ مداوم دارید و نمی‌توانید مایعات را نگه دارید؟' },
  { id: 'urinary_fever', groups: ['back', 'pelvis', 'fever'], level: 'urgent', text: 'آیا همراه تب، درد پهلو یا سوزش ادرار دارید؟' },
  { id: 'immunocompromised', groups: ['fever'], level: 'urgent', text: 'آیا شیمی‌درمانی می‌شوید یا داروی سرکوب‌کننده ایمنی مصرف می‌کنید؟' },
];

const ONSET = ['sudden', 'gradual', 'unknown'];
const DURATIONS = { lt_6h: 3, lt_24h: 12, d1_3: 48, d4_7: 120, w1_4: 336, gt_month: 1000 };
const WHO = ['self', 'child', 'other'];
const SEX = ['female', 'male', 'other'];
export const VITAL_RANGES = { temp_c: [34, 43], spo2: [50, 100], sys: [60, 260], dia: [30, 160], hr: [30, 220] };

export const ACUITY = {
  emergency: { color: 'red', label: 'اورژانسی', action: 'همین حالا با اورژانس ۱۱۵ تماس بگیرید یا به نزدیک‌ترین اورژانس بروید.', timeframe: 'فوری' },
  urgent:    { color: 'amber', label: 'فوری', action: 'امروز و در اولین فرصت با پزشک ویزیت شوید.', timeframe: 'طی چند ساعت' },
  routine:   { color: 'green', label: 'غیرفوری', action: 'ویزیت با پزشک در یکی دو روز آینده توصیه می‌شود.', timeframe: '۲۴ تا ۷۲ ساعت' },
  self_care: { color: 'blue', label: 'مراقبت در منزل', action: 'مراقبت در منزل و پایش علائم کافی به نظر می‌رسد؛ در صورت تمایل می‌توانید با پزشک مشورت کنید.', timeframe: 'پایش' },
};
const ORDER = ['self_care', 'routine', 'urgent', 'emergency'];
const up = (a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a);
const stepUp = (lvl) => ORDER[Math.min(ORDER.indexOf(lvl) + 1, ORDER.length - 1)];

// Questions applicable to a set of regions/symptoms (used by the client wizard too).
export function questionsFor({ regions = [], symptoms = [], may_be_pregnant = false }) {
  const groups = new Set(['always']);
  for (const r of regions) if (REGIONS[r]) groups.add(REGIONS[r].group);
  for (const s of symptoms) if (GENERAL_SYMPTOMS[s]) groups.add(GENERAL_SYMPTOMS[s].group);
  return QUESTIONS.filter((q) => q.groups.some((g) => groups.has(g)) && (!q.when || (q.when === 'may_be_pregnant' && may_be_pregnant)));
}

export function catalog() {
  return {
    rule_version: STRUCTURED_RULE_VERSION,
    regions: Object.entries(REGIONS).map(([id, r]) => ({ id, label: r.label, view: r.view, group: r.group })),
    symptoms: Object.entries(GENERAL_SYMPTOMS).map(([id, s]) => ({ id, label: s.label, group: s.group })),
    questions: QUESTIONS.map(({ id, groups, level, text, flag, when }) => ({ id, groups, level, text, flag: flag ?? null, when: when ?? null })),
    durations: Object.keys(DURATIONS),
    vital_ranges: VITAL_RANGES,
    acuity: ACUITY,
  };
}

// ---------------------------------------------------------------- validation
export class FormError extends Error {}

export function validateForm(f) {
  if (!f || typeof f !== 'object') throw new FormError('فرم تریاژ نامعتبر است');
  const out = {};
  out.who = WHO.includes(f.who) ? f.who : 'self';
  if (f.age_years != null) {
    const a = Number(f.age_years);
    if (!Number.isFinite(a) || a < 0 || a > 120) throw new FormError('سن نامعتبر است');
    out.age_years = a;
  }
  out.sex = SEX.includes(f.sex) ? f.sex : null;
  out.may_be_pregnant = !!f.may_be_pregnant && out.sex === 'female';
  out.regions = [...new Set((f.regions ?? []).filter((r) => REGIONS[r]))];
  out.symptoms = [...new Set((f.symptoms ?? []).filter((s) => GENERAL_SYMPTOMS[s]))];
  if (!out.regions.length && !out.symptoms.length && !String(f.note ?? '').trim()) {
    throw new FormError('حداقل یک ناحیه یا علامت را انتخاب کنید');
  }
  const allowed = new Set(questionsFor(out).map((q) => q.id));
  out.answers = {};
  for (const [k, v] of Object.entries(f.answers ?? {})) {
    if (allowed.has(k) && ['yes', 'no', 'unsure'].includes(v)) out.answers[k] = v;
  }
  if (f.severity != null) {
    const s = Number(f.severity);
    if (!Number.isInteger(s) || s < 0 || s > 10) throw new FormError('شدت باید عددی بین ۰ تا ۱۰ باشد');
    out.severity = s;
  }
  out.onset = ONSET.includes(f.onset) ? f.onset : 'unknown';
  out.duration = DURATIONS[f.duration] != null ? f.duration : null;
  out.vitals = {};
  for (const [k, [lo, hi]] of Object.entries(VITAL_RANGES)) {
    const v = f.vitals?.[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new FormError(`مقدار ${k} خارج از محدوده قابل قبول است`);
    out.vitals[k] = n;
  }
  out.note = String(f.note ?? '').trim().slice(0, 500);
  return out;
}

// ---------------------------------------------------------------- assessment
export function assessStructured(form, { chronic_conditions = [] } = {}) {
  const reasons = [];
  const redFlags = [];
  let level = 'routine';
  const raise = (to, why, flag) => { level = up(level, to); reasons.push(why); if (flag) redFlags.push(flag); };

  // 1) discriminators
  for (const q of questionsFor(form)) {
    const a = form.answers[q.id];
    if (a === 'yes') raise(q.level, `answer:${q.id}`, q.level === 'emergency' ? q.flag : null);
    else if (a === 'unsure') raise('urgent', `unsure:${q.id}`); // unsure about a red flag → never lower than urgent
  }

  // 2) vitals (self-measured with a device)
  const v = form.vitals;
  const ageMonths = form.age_years != null ? form.age_years * 12 : null;
  if (v.spo2 != null) { if (v.spo2 < 92) raise('emergency', 'spo2<92', 'اکسیژن خون کمتر از ۹۲٪'); else if (v.spo2 < 95) raise('urgent', 'spo2<95'); }
  if (v.sys != null) { if (v.sys < 90) raise('emergency', 'sbp<90', 'فشار خون سیستولیک کمتر از ۹۰'); else if (v.sys >= 180) raise('urgent', 'sbp>=180'); }
  if (v.dia != null && v.dia >= 120) raise('urgent', 'dbp>=120');
  if (v.hr != null) { if (v.hr >= 150 || v.hr <= 40) raise('emergency', 'hr_extreme', 'ضربان قلب بسیار غیرطبیعی'); else if (v.hr >= 120) raise('urgent', 'hr>=120'); }
  const hasFever = (v.temp_c != null && v.temp_c >= 38) || form.symptoms.includes('fever');
  if (v.temp_c != null && v.temp_c >= 40) raise('urgent', 'temp>=40');
  if (hasFever && ageMonths != null && ageMonths < 3) raise('emergency', 'infant_fever', 'تب در نوزاد زیر ۳ ماه');

  // 3) pain (NRS-11), onset and time course
  const sev = form.severity ?? 0;
  const hours = form.duration ? DURATIONS[form.duration] : null;
  if (form.onset === 'sudden' && sev >= 7 && (form.regions.includes('head') || form.regions.includes('chest'))) {
    raise('emergency', 'sudden_severe_head_or_chest', 'درد ناگهانی و شدید در سر یا قفسه سینه');
  }
  if (sev >= 8) raise('urgent', 'nrs>=8');
  if (form.regions.includes('chest') && sev >= 4) raise('urgent', 'chest_pain_moderate');
  if (hasFever && hours != null && hours >= 72) raise('urgent', 'fever>=72h');
  const chronic = chronic_conditions.join(' ');
  if (/قلب|دیابت|نارسایی|سرطان|پیوند/.test(chronic) && sev >= 5) raise('urgent', 'chronic_modifier');

  // 4) self-care only when everything is mild, recent and nothing was flagged
  if (level === 'routine' && sev <= 3 && !redFlags.length && !reasons.length && (hours == null || hours < 72)
      && form.regions.every((r) => !['chest', 'abdomen_upper', 'abdomen_lower'].includes(r))
      && form.symptoms.every((s) => !['dyspnea', 'palpitations', 'injury', 'mood'].includes(s))) {
    level = 'self_care';
    reasons.push('mild_self_limiting');
  }

  // 5) free text also passes the fixed emergency rules
  if (form.note) {
    const t = assessText({ symptoms: [{ name: form.note }], age_years: form.age_years });
    if (t.urgency_level === 'emergency') { level = 'emergency'; redFlags.push(...t.red_flags); reasons.push('free_text_red_flag'); }
  }

  // specialty
  let specialty = 'general';
  const firstRegion = form.regions[0] && REGIONS[form.regions[0]];
  const firstSymptom = form.symptoms[0] && GENERAL_SYMPTOMS[form.symptoms[0]];
  if (firstRegion) specialty = firstRegion.specialty;
  else if (firstSymptom) specialty = firstSymptom.specialty;
  if (form.regions.includes('pelvis') && form.sex === 'female') specialty = 'gynecology';
  if (form.symptoms.includes('mood')) specialty = 'psychiatry';
  if ((form.who === 'child' || (form.age_years != null && form.age_years < 14))) specialty = 'pediatrics';

  return {
    urgency_level: level,
    recommended_specialty: specialty,
    red_flags: [...new Set(redFlags)],
    reasons,
    acuity: ACUITY[level],
    safety_net: safetyNet(form, level),
    rule_version: `${STRUCTURED_RULE_VERSION}+${TEXT_RULE_VERSION}`,
  };
}

function safetyNet(form, level) {
  if (level === 'emergency') return ['تا رسیدن کمک تنها نمانید و چیزی نخورید.'];
  const out = [];
  const g = new Set([...form.regions.map((r) => REGIONS[r].group), ...form.symptoms.map((s) => GENERAL_SYMPTOMS[s].group)]);
  if (g.has('chest')) out.push('اگر درد سینه شدیدتر شد، به بازو یا فک تیر کشید، یا عرق سرد کردید، فوراً با ۱۱۵ تماس بگیرید.');
  if (g.has('head')) out.push('اگر سردرد ناگهان بسیار شدید شد، یا ضعف یک طرف بدن یا اختلال تکلم پیدا کردید، فوراً با ۱۱۵ تماس بگیرید.');
  if (g.has('abdomen')) out.push('اگر استفراغ خونی، مدفوع سیاه یا درد شدید و مداوم شکم پیدا کردید، فوراً به اورژانس بروید.');
  if (g.has('fever') || g.has('resp')) out.push('اگر تب بیش از ۳ روز ادامه یافت، یا تنگی نفس یا لکه‌های پوستی پیدا کردید، زودتر با پزشک تماس بگیرید.');
  if (g.has('mood')) out.push('اگر فکر آسیب به خود دارید، همین حالا با ۱۱۵ یا صدای مشاور بهزیستی ۱۴۸۰ تماس بگیرید.');
  out.push('اگر حال‌تان بدتر شد یا علامت جدیدی پیدا کردید، دوباره ارزیابی کنید یا با ۱۱۵ تماس بگیرید.');
  return out;
}

// Human-readable Persian summary of the form (stored as the patient's chat message).
export function summarizeForm(f) {
  const parts = [];
  const who = { self: 'خودم', child: 'کودکم', other: 'شخص دیگر' }[f.who];
  parts.push(`برای: ${who}${f.age_years != null ? `، ${Math.round(f.age_years * 10) / 10} ساله` : ''}`);
  if (f.regions.length) parts.push(`محل: ${f.regions.map((r) => REGIONS[r].label).join('، ')}`);
  if (f.symptoms.length) parts.push(`علائم: ${f.symptoms.map((s) => GENERAL_SYMPTOMS[s].label).join('، ')}`);
  if (f.severity != null) parts.push(`شدت درد: ${f.severity} از ۱۰`);
  const onset = { sudden: 'ناگهانی', gradual: 'تدریجی' }[f.onset];
  if (onset) parts.push(`شروع: ${onset}`);
  const dur = { lt_6h: 'کمتر از ۶ ساعت', lt_24h: 'کمتر از یک روز', d1_3: '۱ تا ۳ روز', d4_7: '۴ تا ۷ روز', w1_4: '۱ تا ۴ هفته', gt_month: 'بیش از یک ماه' }[f.duration];
  if (dur) parts.push(`مدت: ${dur}`);
  const yes = QUESTIONS.filter((q) => f.answers[q.id] === 'yes').map((q) => q.flag ?? q.text.replace(/^آیا /, '').replace(/[؟?]$/, ''));
  if (yes.length) parts.push(`پاسخ مثبت: ${yes.join('؛ ')}`);
  const vit = [];
  if (f.vitals.temp_c != null) vit.push(`دما ${f.vitals.temp_c}°C`);
  if (f.vitals.spo2 != null) vit.push(`اکسیژن ${f.vitals.spo2}٪`);
  if (f.vitals.sys != null) vit.push(`فشار ${f.vitals.sys}/${f.vitals.dia ?? '?'}`);
  if (f.vitals.hr != null) vit.push(`ضربان ${f.vitals.hr}`);
  if (vit.length) parts.push(`علائم حیاتی (اندازه‌گیری با دستگاه): ${vit.join('، ')}`);
  if (f.note) parts.push(`توضیح: ${f.note}`);
  return parts.join('\n');
}
