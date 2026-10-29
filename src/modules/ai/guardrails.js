// Input/output guardrails (Llama Guard + NeMo rules in production; deterministic rules here).
import { normalizeFa } from '../../lib/fa.js';
import { detectEmergency } from './triage.js';

const MAX_INPUT = 2000;

const INJECTION = [
  'ignore previous', 'ignore all previous', 'system prompt', 'you are now', 'دستورات قبلی را نادیده',
  'نقش خود را فراموش', 'پرامپت سیستم',
].map(normalizeFa);

export function checkInput(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, code: 'empty', message: 'پیام خالی است' };
  if (raw.length > MAX_INPUT) return { ok: false, code: 'too_long', message: `پیام حداکثر ${MAX_INPUT} کاراکتر باشد` };
  const t = normalizeFa(raw);
  const injection = INJECTION.some((p) => t.includes(p));
  return { ok: true, emergency: detectEmergency(raw), injection };
}

// The assistant never states a diagnosis, a dose, or a treatment change (design doc §4.5).
const BLOCKED_OUTPUT = [
  /تشخیص\s*(شما|قطعی|احتمالی|من)?\s*(این|اینه|عبارت|:)/,
  /تشخیص\s+(شما|قطعی|احتمالی|اولیه من)\s*[^.\n]{0,40}(است|هست|باشد|می‌?باشد)/,
  /(احتمالا|احتمالاً|به احتمال زیاد)\s+(شما\s+)?[^.\n]{0,30}\s+(دارید|گرفته‌?اید|گرفتید)/,
  /شما\s+(به\s+)?[؀-ۿ\s]{2,30}\s+(مبتلا|دچار)\s+(هستید|شده‌?اید)/,
  /\d+\s*(میلی\s*گرم|میلی‌گرم|mg|سی\s*سی|cc|واحد)/i,
  /(روزی|هر)\s*\d+\s*(بار|ساعت)\s*(یک|دو|۱|۲)?\s*(قرص|کپسول|عدد)/,
  /(قرص|کپسول|شربت|آمپول)\s+[؀-ۿa-zA-Z]+\s+(بخورید|مصرف کنید|بزنید)/,
  /(داروی?\s*(خود|تان|ت)\s*را\s*(قطع|کم|زیاد)\s*کنید)/,
  /\b(diagnos(is|ed)|dosage|take \d+)/i,
];

export const SAFE_REFERRAL =
  'این موضوع نیاز به ارزیابی پزشک دارد و من نمی‌توانم تشخیص یا دوز دارو اعلام کنم. ' +
  'اگر بخواهید، همین حالا برایتان نوبت ویزیت آنلاین با پزشک می‌گیرم.';

export function checkOutput(text) {
  const t = String(text ?? '');
  const n = normalizeFa(t); // Persian digits → ASCII, ZWNJ → space
  const hit = BLOCKED_OUTPUT.find((re) => re.test(t) || re.test(n));
  return hit ? { ok: false, replacement: SAFE_REFERRAL, rule: String(hit) } : { ok: true };
}

export const EMERGENCY_TEMPLATE = (flags) =>
  `⚠️ علائمی که گفتید (${flags.join('، ')}) ممکن است نشانه یک وضعیت اورژانسی باشد.\n` +
  'همین حالا با اورژانس ۱۱۵ تماس بگیرید یا به نزدیک‌ترین مرکز درمانی بروید.\n' +
  'درخواست شما برای اپراتور انسانی ارسال شد و به‌زودی با شما تماس گرفته می‌شود. تا آن زمان تنها نمانید.';

export const EMERGENCY_HOLD =
  'گفتگوی شما در وضعیت اورژانس است. لطفاً با ۱۱۵ تماس بگیرید. اپراتور انسانی در جریان است و پاسخ می‌دهد.';
