// Inappropriate content check for text people type into the system (support chat, the health
// assistant, staff answers, rating comments): insults and obscene words (also written with spaces,
// dots, repeated letters or in Finglish), advertising links, and meaningless text. A rejected
// message is not stored; the attempt is logged (moderation_events) and repeated abuse pauses
// sending for a while.
import { normalizeFa } from './fa.js';

// Whole words only (after normalising), so «کسی»، «کسر»، «خرید» are not caught.
const INSULT = [
  'احمق', 'بیشعور', 'بی‌شعور', 'نفهم', 'الاغ', 'عوضی', 'کثافت', 'آشغال', 'اشغال', 'پدرسگ', 'پدر سگ', 'حرومزاده', 'حرامزاده', 'حروم زاده',
  'بی‌ناموس', 'بیناموس', 'دیوث', 'قرمساق', 'لاشی', 'لجن', 'گوساله', 'خفه شو', 'گمشو', 'گم شو', 'بیشرف', 'بی‌شرف', 'پفیوز', 'مرتیکه', 'زنیکه',
  'خر', 'گاو', 'سگ صفت', 'ننه سگ', 'بی پدر', 'بی‌پدر', 'بی مادر',
  'idiot', 'stupid', 'asshole', 'bastard', 'bitch', 'ahmagh', 'ahmag', 'kesafat', 'avazi', 'bisharaf',
];
const OBSCENE = [
  'کیر', 'کیری', 'کس', 'کسکش', 'کس‌کش', 'کس کش', 'کون', 'کونی', 'جنده', 'جاکش', 'مادرجنده', 'مادر جنده', 'ننت', 'گوه', 'گوز', 'ممه', 'سکس', 'سکسی',
  'پورن', 'شومبول', 'تخمی', 'تخم سگ', 'اوبی', 'جقی', 'لاکونی',
  'fuck', 'fucking', 'shit', 'dick', 'pussy', 'porn', 'sex', 'kir', 'kos', 'koon', 'kun', 'jende', 'jakesh', 'koskesh', 'kiri',
];
const ALLOWED_LINK = /(^|\.)darman-plus\.ir$/i;

// Letters only, one space between words, a letter repeated in a row counted once; single letters
// written apart («ک ی ر», «ک.ی.ر») are joined back into a word.
function squash(text) {
  let s = normalizeFa(String(text ?? '')).toLowerCase().replace(/‌/g, ' ');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(^|\s)((?:\p{L}\s){2,}\p{L})(?=\s|$)/gu, (m, pre, letters) => pre + letters.replace(/\s/g, ''));
  return s.replace(/(\p{L})\1+/gu, '$1');
}
const toSet = (list) => new Set(list.map(squash));
const INSULTS = toSet(INSULT);
const OBSCENES = toSet(OBSCENE);
const phraseHit = (s, set) => {
  const words = s.split(' ');
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) if (set.has(words.slice(i, i + n).join(' '))) return words.slice(i, i + n).join(' ');
  }
  return null;
};

export const MODERATION_MESSAGES = {
  insult: 'پیام شما شامل واژه‌های توهین‌آمیز است و ارسال نشد. لطفاً پرسش یا مشکل خود را محترمانه بنویسید.',
  obscene: 'پیام شما شامل واژه‌های نامناسب است و ارسال نشد. لطفاً از واژه‌های محترمانه استفاده کنید؛ برای توضیح علائم بدنی می‌توانید از نام‌های پزشکی (مانند «ناحیه تناسلی») استفاده کنید.',
  spam: 'ارسال لینک یا پیام تبلیغاتی در این بخش مجاز نیست.',
  gibberish: 'پیام شما قابل فهم نیست. لطفاً پرسش خود را به‌صورت یک جمله بنویسید.',
};

// → null when fine, otherwise { reason, message, match }.
export function checkText(text, { allowLinks = false } = {}) {
  const raw = String(text ?? '');
  const s = squash(raw);
  const insult = phraseHit(s, INSULTS);
  const obscene = phraseHit(s, OBSCENES);
  const hit = obscene ? ['obscene', obscene] : insult ? ['insult', insult] : null;
  if (hit) return { reason: hit[0], message: MODERATION_MESSAGES[hit[0]], match: hit[1] };
  if (!allowLinks) {
    const links = raw.match(/\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|ir|info|xyz|top|me|io|co)\b(?:\/[^\s]*)?/gi) ?? [];
    const foreign = links.filter((l) => !ALLOWED_LINK.test(l.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]));
    if (foreign.length || /(?:t\.me|telegram\.me|wa\.me|instagram\.com)\//i.test(raw)) return { reason: 'spam', message: MODERATION_MESSAGES.spam, match: foreign[0] ?? 'link' };
  }
  // Meaningless: hardly any letters, or one character over and over.
  const letters = (raw.match(/[\p{L}\p{N}]/gu) ?? []).length; // a tracking number alone is fine
  const visible = raw.replace(/\s/g, '').length;
  if (visible >= 4 && letters / visible < 0.3) return { reason: 'gibberish', message: MODERATION_MESSAGES.gibberish, match: null };
  if (/(\p{L}|\p{P}|\p{S})\1{7,}/u.test(raw.replace(/\s/g, ''))) return { reason: 'gibberish', message: MODERATION_MESSAGES.gibberish, match: null };
  return null;
}

// Repeated abuse: after this many rejected messages in an hour, sending pauses for the hour.
const BLOCK_AFTER = 5;

// Checks text for one place (context: 'support', 'assistant', 'staff_reply', 'rating') and logs a
// rejection. Throws ApiError(422 inappropriate_content | 429 moderation_blocked).
export function createModerator({ db, ApiError, uuid, nowIso }) {
  return function moderate(ctx, text, context, opts = {}) {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const recent = () => db.get('SELECT COUNT(*) AS n FROM moderation_events WHERE user_id = ? AND created_at > ?', ctx.user.sub, hourAgo).n;
    if (recent() >= BLOCK_AFTER) throw new ApiError(429, 'moderation_blocked', 'به دلیل ارسال مکرر پیام نامناسب، ارسال پیام تا یک ساعت ممکن نیست.');
    const hit = checkText(text, opts);
    if (!hit) return;
    db.run('INSERT INTO moderation_events (id, tenant_id, user_id, context, reason, excerpt, created_at) VALUES (?,?,?,?,?,?,?)',
      uuid(), ctx.tenantId, ctx.user.sub, context, hit.reason, String(text).slice(0, 200), nowIso());
    throw new ApiError(422, 'inappropriate_content', recent() >= BLOCK_AFTER - 1 ? `${hit.message} در صورت تکرار، ارسال پیام موقتاً مسدود می‌شود.` : hit.message);
  };
}
