// Intent classification + entity extraction. Production uses a small classifier model; this
// deterministic version keeps the same interface ({ intent, confidence, entities }).
import { normalizeFa } from '../../lib/fa.js';
import { includesAny } from './triage.js';

export const INTENT_MODEL_VERSION = 'intent-rules-v1';

const KW = (arr) => arr.map(normalizeFa);
const GREETING = KW(['سلام', 'درود', 'وقت بخیر', 'صبح بخیر', 'عصر بخیر', 'hello', 'hi']);
const THANKS = KW(['ممنون', 'مرسی', 'متشکر', 'سپاس', 'دستت درد نکنه', 'thanks']);
const BOOKING = KW(['نوبت', 'رزرو', 'وقت بگیر', 'وقت ویزیت', 'ویزیت می خوام', 'ویزیت میخوام', 'دکتر می خوام', 'دکتر میخوام',
  'میخوام دکتر', 'با دکتر صحبت', 'با پزشک صحبت', 'وقت دکتر', 'ویزیت انلاین', 'مشاوره بگیرم']);
const CANCEL = KW(['لغو نوبت', 'کنسل', 'نوبتمو لغو', 'نوبتم را لغو', 'لغو کن']);
const HUMAN = KW(['اپراتور', 'پشتیبانی', 'با یک انسان', 'با یه ادم', 'با یک نفر', 'کارشناس', 'نیروی انسانی']);
const AFFIRM = KW(['بله', 'آره', 'اره', 'باشه', 'تایید', 'تأیید', 'اوکی', 'حتما', 'درسته', 'موافقم', 'قبول', 'بلی', 'yes', 'ok']);
const DENY = KW(['نه', 'خیر', 'انصراف', 'بیخیال', 'بی خیال', 'منصرف', 'نمیخوام', 'نمی خواهم', 'لازم نیست', 'no']);
const SYMPTOM = KW(['درد', 'تب', 'سرفه', 'تهوع', 'استفراغ', 'اسهال', 'خارش', 'سرگیجه', 'تنگی نفس', 'سوزش', 'ورم', 'تورم',
  'خونریزی', 'بی حسی', 'گلودرد', 'سردرد', 'دلدرد', 'کمردرد', 'جوش', 'لک', 'ریزش مو', 'بی خوابی', 'اضطراب', 'افسردگی',
  'تپش قلب', 'خستگی', 'ضعف', 'سرماخوردگی', 'آبریزش', 'ابریزش', 'گرفتگی', 'عطسه', 'یبوست', 'نفخ', 'کهیر', 'حالم بده',
  'مریض', 'بیمارم', 'علائم', 'علامت', 'ناراحتی', 'مشکل گوارشی', 'تشنج', 'بیهوش', 'غش']);
const QUESTION = KW(['چطور', 'چگونه', 'چیست', 'چیه', 'چه', 'آیا', 'ایا', 'کجا', 'کی ', 'چقدر', 'چند', 'میشه', 'می شود', 'ممکنه']);

const SPECIALTY_MENTIONS = [
  ['psychiatry', ['روانپزشک', 'روان پزشک', 'اعصاب و روان', 'روانشناس', 'روان شناس']],
  ['neurology', ['مغز و اعصاب', 'نورولوژ', 'متخصص اعصاب']],
  ['cardiology', ['قلب']],
  ['dermatology', ['پوست']],
  ['pediatrics', ['کودکان', 'اطفال', 'متخصص بچه']],
  ['ent', ['گوش و حلق', 'حلق و بینی', 'گوش حلق', 'گوش و حلق و بینی']],
  ['gynecology', ['زنان', 'زایمان']],
  ['orthopedics', ['ارتوپد']],
  ['gastroenterology', ['گوارش']],
  ['internal', ['داخلی']],
  ['general', ['عمومی']],
].map(([c, kws]) => [c, kws.map(normalizeFa)]);

const ORDINALS = { 'اولی': 1, 'اول': 1, 'دومی': 2, 'دوم': 2, 'سومی': 3, 'سوم': 3, 'چهارمی': 4, 'چهارم': 4, 'پنجمی': 5 };
const NUM_WORDS = { 'یک': 1, 'یه': 1, 'دو': 2, 'سه': 3, 'چهار': 4, 'پنج': 5, 'شش': 6, 'شیش': 6, 'هفت': 7, 'هشت': 8, 'ده': 10 };

function parseNum(tok) {
  if (/^\d+$/.test(tok)) return Number(tok);
  return NUM_WORDS[tok] ?? null;
}

export function extractEntities(text) {
  const t = normalizeFa(text);
  const e = {};

  // duration
  const dm = t.match(/(\d+|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|ده)\s*(ساعت|روز|هفته|ماه)/);
  if (dm) {
    const n = parseNum(dm[1]);
    e.duration_hours = n * { 'ساعت': 1, 'روز': 24, 'هفته': 168, 'ماه': 720 }[dm[2]];
  } else if (/از دیروز|دیروز/.test(t)) e.duration_hours = 24;
  else if (/از دیشب|امروز صبح|از صبح/.test(t)) e.duration_hours = 8;
  else if (/چند روز/.test(t)) e.duration_hours = 72;
  else if (/چند هفته|مدت هاست|خیلی وقته/.test(t)) e.duration_hours = 336;

  // severity (1..10)
  const sm = t.match(/(?:شدت|شدتش|درجه)\s*(?:اش|ش)?\s*(\d{1,2})/) || t.match(/(\d{1,2})\s*(?:از|\/)\s*10/);
  if (sm && Number(sm[1]) >= 1 && Number(sm[1]) <= 10) e.severity = Number(sm[1]);
  else if (/^\s*(\d{1,2})\s*$/.test(t) && Number(t) >= 1 && Number(t) <= 10) e.bare_number = Number(t);
  else if (/خیلی شدید|غیر قابل تحمل|غیرقابل تحمل|طاقت فرسا/.test(t)) e.severity = 9;
  else if (/شدید|زیاد/.test(t)) e.severity = 7;
  else if (/متوسط/.test(t)) e.severity = 5;
  else if (/خفیف|کم|یکم|یه کم|جزئی/.test(t)) e.severity = 3;

  // option selection
  const om = t.match(/(?:گزینه|شماره|نوبت)\s*(\d)/) || t.match(/^\s*(\d)\s*$/);
  if (om) e.option = Number(om[1]);
  else for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`(^|\\s)${w}($|\\s)`).test(t)) { e.option = n; break; }

  // specialty mentioned explicitly ("متخصص پوست", "نوبت دکتر قلب")
  if (/متخصص|دکتر|پزشک|نوبت|ویزیت|فوق تخصص/.test(t)) {
    for (const [code, kws] of SPECIALTY_MENTIONS) {
      if (kws.some((k) => t.includes(k))) { e.specialty = code; break; }
    }
  }

  // age ("۳۵ سالمه", "بچه ۲ ماهه")
  const am = t.match(/(\d{1,3})\s*(سال|ماه)(?:مه|ه|م|شه)/);
  if (am) e.age_years = am[2] === 'ماه' ? Number(am[1]) / 12 : Number(am[1]);
  return e;
}

export function classify(text) {
  const t = normalizeFa(text);
  const entities = extractEntities(text);
  const words = t.split(' ').length;
  const has = (kws) => includesAny(t, kws);

  let intent = 'general_question';
  let confidence = 0.55;
  if (words <= 4 && has(AFFIRM) && !has(DENY)) { intent = 'affirm'; confidence = 0.95; }
  else if (words <= 4 && has(DENY)) { intent = 'deny'; confidence = 0.9; }
  else if (entities.option && words <= 3) { intent = 'select_option'; confidence = 0.95; }
  else if (has(HUMAN)) { intent = 'human_request'; confidence = 0.9; }
  else if (has(CANCEL)) { intent = 'cancel_request'; confidence = 0.85; }
  else if (has(SYMPTOM)) { intent = 'symptom_report'; confidence = has(BOOKING) ? 0.75 : 0.85; }
  else if (has(BOOKING)) { intent = 'booking_request'; confidence = 0.9; }
  else if (words <= 4 && has(GREETING)) { intent = 'greeting'; confidence = 0.95; }
  else if (words <= 5 && has(THANKS)) { intent = 'thanks'; confidence = 0.95; }
  else if (has(QUESTION) || /[?؟]/.test(t)) { intent = 'general_question'; confidence = 0.7; }
  else if (entities.severity || entities.duration_hours || entities.bare_number) { intent = 'symptom_detail'; confidence = 0.7; }

  return { intent, confidence, entities, model_version: INTENT_MODEL_VERSION };
}
