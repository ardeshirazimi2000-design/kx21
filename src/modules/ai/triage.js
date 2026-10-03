// Triage Engine: deterministic, versioned rule engine (design doc §3, §4.5).
// The LLM never decides urgency. Every result stores rule_version so it can be reproduced.
import { normalizeFa } from '../../lib/fa.js';

export const RULE_VERSION = 'triage-rules-2026.10.1';

// Red flags → emergency. Matched against normalised text of every symptom and the free text.
// Each entry: [id, label, patterns (all normalised), optional predicate on context]
const RED_FLAGS = [
  ['chest_pain', 'درد قفسه سینه', ['درد قفسه سینه', 'درد سینه', 'سینه درد', 'فشار روی سینه', 'تیر کشیدن سینه', 'قفسه سینم', 'سینم درد', 'سینه ام درد', 'سینه ام تیر', 'chest pain']],
  ['severe_dyspnea', 'تنگی نفس شدید', ['نفسم بالا نمیاد', 'نفسم بالا نمی اید', 'نمیتونم نفس بکشم', 'نمی توانم نفس بکشم', 'تنگی نفس شدید', 'خفگی', 'کبودی لب']],
  ['unconscious', 'کاهش هوشیاری', ['بیهوش', 'غش کرد', 'از هوش رفت', 'هوشیار نیست', 'به هوش نمیاد']],
  ['seizure', 'تشنج', ['تشنج', 'تشنج کرد', 'صرع']],
  ['stroke', 'علائم سکته مغزی', ['فلج', 'بی حسی یک طرف', 'کج شدن صورت', 'صورتم کج', 'نمیتونم حرف بزنم', 'اختلال تکلم ناگهانی', 'سکته']],
  ['severe_bleeding', 'خونریزی شدید', ['خونریزی شدید', 'خونریزی بند نمیاد', 'خون بالا اوردن', 'استفراغ خونی', 'خونریزی زیاد']],
  ['suicidal', 'افکار آسیب به خود', ['خودکشی', 'میخوام خودمو بکشم', 'می خواهم خودم را بکشم', 'به زندگی پایان', 'آسیب زدن به خودم', 'اسیب زدن به خودم']],
  ['anaphylaxis', 'واکنش آلرژیک شدید', ['تورم گلو', 'ورم زبان', 'تورم صورت و گلو', 'شوک آنافیلاکسی', 'شوک انافیلاکسی']],
  ['poisoning', 'مسمومیت یا مصرف بیش از حد', ['مسمومیت', 'اوردوز', 'قرص زیاد خورده', 'سم خورده']],
  ['major_trauma', 'آسیب شدید', ['تصادف شدید', 'ضربه به سر و استفراغ', 'سقوط از ارتفاع', 'شکستگی باز']],
  ['infant_fever', 'تب در نوزاد زیر ۳ ماه', ['نوزاد تب'], (c) => c.ageMonths != null && c.ageMonths < 3 && c.hasFever],
].map(([id, label, pats, pred]) => ({ id, label, pats: pats.map(normalizeFa), pred }));

// Specialty routing by keyword (first match wins; order matters).
const SPECIALTY_RULES = [
  ['psychiatry', ['اضطراب', 'افسردگی', 'بی خوابی', 'استرس', 'حمله پانیک', 'وسواس']],
  ['cardiology', ['تپش قلب', 'فشار خون', 'قلب', 'درد سینه', 'ورم پا']],
  ['dermatology', ['جوش', 'اکنه', 'آکنه', 'خارش', 'پوست', 'ریزش مو', 'کهیر', 'اگزما', 'لک']],
  ['ent', ['گلو درد', 'گلودرد', 'گوش درد', 'سینوزیت', 'گرفتگی بینی', 'لوزه', 'وزوز گوش']],
  ['gastroenterology', ['دل درد', 'دلدرد', 'معده', 'اسهال', 'یبوست', 'سوزش سر دل', 'ریفلاکس', 'نفخ', 'تهوع', 'استفراغ']],
  ['neurology', ['سردرد', 'سر درد', 'میگرن', 'سرگیجه', 'بی حسی', 'گزگز']],
  ['orthopedics', ['کمر درد', 'کمردرد', 'زانو', 'درد مفاصل', 'شانه', 'گردن درد', 'پیچ خوردگی']],
  ['gynecology', ['قاعدگی', 'پریود', 'بارداری', 'حاملگی', 'ترشحات']],
  ['pediatrics', ['کودک', 'بچه', 'نوزاد', 'شیرخوار']],
  ['general', ['تب', 'سرماخوردگی', 'سرفه', 'آنفولانزا', 'انفولانزا', 'خستگی', 'بدن درد']],
].map(([sp, kws]) => [sp, kws.map(normalizeFa)]);

const FEVER = ['تب', 'fever'].map(normalizeFa);
const SELF_CARE_HINTS = ['سرماخوردگی', 'آبریزش بینی', 'ابریزش بینی', 'عطسه', 'گلو درد خفیف', 'سردرد خفیف'].map(normalizeFa);

// Patterns match at a word start. Short patterns (e.g. "تب") must be a whole word, optionally with
// a common suffix, so that "تبریک" or "مکتب" do not count as fever.
const SEP = '[\\s|,.،؛!?؟:()]';
const reCache = new Map();
const patternRe = (p) => {
  let re = reCache.get(p);
  if (!re) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = p.length <= 3 ? `(م|ت|ش|ی|ه|دار|های|ها)?(?=$|${SEP})` : '';
    reCache.set(p, (re = new RegExp(`(^|${SEP})${esc}${tail}`)));
  }
  return re;
};
export const includesAny = (text, pats) => pats.some((p) => patternRe(p).test(text));

/**
 * @param {{symptoms: {name:string, duration_hours?:number, severity?:number}[], free_text?: string,
 *          age_years?: number, chronic_conditions?: string[]}} input
 */
export function assess(input) {
  const symptoms = input.symptoms ?? [];
  const texts = symptoms.map((s) => normalizeFa(s.name));
  const all = normalizeFa([...texts, input.free_text ?? ''].join(' | '));
  const maxSeverity = Math.max(0, ...symptoms.map((s) => Number(s.severity) || 0));
  const maxDuration = Math.max(0, ...symptoms.map((s) => Number(s.duration_hours) || 0));
  const hasFever = includesAny(all, FEVER);
  const ctx = {
    hasFever,
    ageMonths: input.age_years != null ? Math.round(input.age_years * 12) : null,
  };
  const chronic = (input.chronic_conditions ?? []).map(normalizeFa).join(' ');

  const redFlags = RED_FLAGS.filter((f) => (f.pred ? f.pred(ctx) : includesAny(all, f.pats))).map((f) => f.label);
  const reasons = [];
  let urgency;

  if (redFlags.length) {
    urgency = 'emergency';
    reasons.push('red_flag');
  } else if (maxSeverity >= 9) {
    urgency = 'urgent';
    reasons.push('severity>=9');
  } else if (hasFever && maxDuration >= 72) {
    urgency = 'urgent';
    reasons.push('fever>=72h');
  } else if (maxSeverity >= 7 || (chronic && (chronic.includes('قلب') || chronic.includes('دیابت')) && maxSeverity >= 5)) {
    urgency = 'urgent';
    reasons.push(maxSeverity >= 7 ? 'severity>=7' : 'chronic_condition_modifier');
  } else if (maxSeverity > 0 && maxSeverity <= 3 && maxDuration < 72 && includesAny(all, SELF_CARE_HINTS)) {
    urgency = 'self_care';
    reasons.push('mild_self_limiting');
  } else {
    urgency = 'routine';
    reasons.push('default');
  }

  let specialty = 'general';
  for (const [sp, kws] of SPECIALTY_RULES) {
    if (includesAny(all, kws)) { specialty = sp; break; }
  }
  if (ctx.ageMonths != null && ctx.ageMonths < 18 * 12 && specialty === 'general') specialty = 'pediatrics';

  return { urgency_level: urgency, recommended_specialty: specialty, red_flags: redFlags, reasons, rule_version: RULE_VERSION };
}

// Fixed-rule emergency detector on raw input text — runs before any model (design doc §4.3 step 3).
export function detectEmergency(text) {
  const t = normalizeFa(text);
  return RED_FLAGS.filter((f) => !f.pred && includesAny(t, f.pats)).map((f) => f.label);
}
