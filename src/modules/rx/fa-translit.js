// Persian → English drug-name matching by sound. Most Persian drug names are phonetic spellings
// of the English generic ("متفورمین" = METFORMIN), so both sides are reduced to a consonant
// skeleton (vowels dropped, look-alike sounds merged) and compared with a small edit distance.
// Used only to FIND candidates; the prescriber always picks the official entry.

const FA = {
  'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'c', 'ح': 'h', 'خ': 'k', 'د': 'd', 'ذ': 's', 'ر': 'r', 'ز': 's', 'ژ': 'j',
  'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 's', 'ط': 't', 'ظ': 's', 'غ': 'g', 'ف': 'f', 'ق': 'k', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l',
  'م': 'm', 'ن': 'n',
};
const squash = (s) => s.replace(/(.)\1+/g, '$1');

export function faSkeleton(text) {
  // و is "v" at the start of a word or when doubled (لووتیروکسین); otherwise a vowel. گز / کس = x.
  const t = String(text ?? '').trim().replace(/(^|\s)و/g, '$1V').replace(/وو/g, 'Vو').replace(/گز/g, 'KS').replace(/\s+/g, '');
  let o = '';
  for (const ch of t) o += ch === 'V' ? 'v' : ch === 'K' ? 'k' : ch === 'S' ? 's' : FA[ch] ?? '';
  return squash(o);
}

export function enSkeleton(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/ch/g, 'k').replace(/x/g, 'ks').replace(/q/g, 'k')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/g(?=[eiy])/g, 'j').replace(/z/g, 's').replace(/w/g, 'v')
    .replace(/[aeiouyh]/g, '');
  return squash(t);
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** index: [[englishName, skeleton]] → best matching English names for a Persian query. */
export function matchPersian(query, index, limit = 4) {
  const qs = faSkeleton(query);
  if (qs.length < 3) return [];
  const qv = qs.replace(/v/g, '');
  const tol = Math.max(1, Math.floor(qs.length / 4));
  const sc = (q, f) => (f.startsWith(q) ? 0 : Math.min(lev(q, f.slice(0, q.length)), lev(q, f.slice(0, q.length + 1))) + 0.5);
  const out = [];
  for (const [name, skel] of index) {
    // "و" may be a vowel or a v in Persian spelling: also compare with v ignored on both sides.
    const s = Math.min(sc(qs, skel), sc(qv, skel.replace(/v/g, '')) + 0.25);
    if (s <= tol) out.push([s + name.length / 1000, name]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

export const buildIndex = (names) => names.map((n) => [n, enSkeleton(n.split(/[/(]/)[0])]);
