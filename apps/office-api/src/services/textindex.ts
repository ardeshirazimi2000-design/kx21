/**
 * Persian text analysis for the smart search: normalisation (Arabic letters, digits, diacritics, ZWNJ),
 * stop words (function words and letter formalities), a light plural stemmer, and adjacent-word phrases.
 */

const STOP = new Set(
  `و در به از که این آن با برای را تا یا هم نیز بر اما اگر چون چه چند هر همه هیچ دیگر خود ما شما او ایشان آنها اینها من تو وی
  است هست نیست بود بودند باشد باشند شد شده شود شوند کرد کرده کند کنند کنید کنیم نمود نموده نماید نمایند گردد گردید گردیده
  دارد دارند داشت داشته خواهد خواهند میشود میشوند میباشد میباشند مینماید میگردد میکند میکنند
  ای ها های هایی یک دو سه بین پس پیش زیر روی نزد طی طبق جهت ضمن توسط بدون درباره پیرو عطف مورخ شماره تاریخ پیوست
  سلام احترام احتراما احتراماً استحضار میرساند خواهشمند خواهشمنداست است دستور فرمایید فرمائید مقرر اقدام لازم مبذول گردد
  جناب آقای آقا خانم سرکار محترم محترمه
  موضوع متن نامه گیرنده رونوشت باسمه تعالی بسمه
  the of and to in for on with`
    .split(/\s+/)
    .map((w) => normalizeFa(w)),
);

/** Same letters and digits for the same word, whichever keyboard typed it. */
export function normalizeFa(s: string): string {
  return s
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[ً-ٰٟـ]/g, '') // diacritics, superscript alef, tatweel
    .replace(/‌|‍/g, '') // ZWNJ/ZWJ: «می‌رساند» = «میرساند»
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Plural suffixes only: more aggressive Persian stemming conflates unrelated words (ایران ≠ ایر). */
export function stem(w: string): string {
  for (const suffix of ['هایی', 'های', 'ها']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  }
  return w;
}

const isTerm = (w: string) => w.length >= 2 && !STOP.has(w) && !/^\d$/.test(w);

/** Words of a text in order; null marks a stop word, which breaks a phrase. */
export function analyze(text: string): (string | null)[] {
  return normalizeFa(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (isTerm(w) ? stem(w) : null));
}

/** Weighted terms of one field: each word, and each pair of adjacent words as a phrase at half weight. */
export function addTerms(into: Map<string, number>, text: string | null | undefined, weight: number) {
  if (!text) return;
  const words = analyze(text);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    into.set(w, (into.get(w) ?? 0) + weight);
    const next = words[i + 1];
    if (next) into.set(`${w}_${next}`, (into.get(`${w}_${next}`) ?? 0) + weight / 2);
  }
}

/** Query terms with their weights (phrases rank above the separate words). */
export function queryTerms(q: string): Map<string, number> {
  const m = new Map<string, number>();
  addTerms(m, q, 1);
  for (const [t, w] of m) m.set(t, t.includes('_') ? w * 3 : w);
  return m;
}

/** «توسعه_صادرات» → «توسعه صادرات» for display. */
export const displayTerm = (t: string) => t.replace(/_/g, ' ');

/**
 * A short excerpt around the first word that matches the query, as segments the client renders
 * (hit=true is highlighted) — never HTML.
 */
export function snippet(text: string, terms: Set<string>, radius = 14): { text: string; hit: boolean }[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (!words[0]) return [];
  const matches = (w: string) => {
    const a = analyze(w).filter(Boolean) as string[];
    return a.some((x) => terms.has(x));
  };
  let first = words.findIndex(matches);
  if (first < 0) first = 0;
  const from = Math.max(0, first - radius);
  const to = Math.min(words.length, first + radius * 2);
  const out: { text: string; hit: boolean }[] = [];
  const push = (text: string, hit: boolean) => {
    const last = out[out.length - 1];
    if (last && !last.hit && !hit) last.text += text;
    else out.push({ text, hit });
  };
  if (from > 0) push('… ', false);
  for (let i = from; i < to; i++) {
    if (i > from) push(' ', false);
    push(words[i], matches(words[i]));
  }
  if (to < words.length) push(' …', false);
  return out;
}
