// Iranian drug directory (Darooyab via a third-party API, e.g. api.majidapi.ir/darooyab):
//   search?search=<name>   → matching drugs (Persian/English names, links)
//   info?url=<darooyab url> → monograph sections (uses, dosing, side effects, interactions …)
// REFERENCE ONLY for the prescriber: shown with its source, never fed into the automatic
// safety checks (free text, unofficial API, no clinical validation). Only drug names leave the
// server — never patient data. Results are cached locally; the response shape is read tolerantly
// because the API is not ours (scripts/check-drug-api.js shows the real shape on the server).
import { ApiError, badRequest } from '../../lib/http.js';
import { nowIso, parseJson } from '../../lib/db.js';

const SEARCH_TTL_MS = 7 * 864e5;
const INFO_TTL_MS = 30 * 864e5;
const INFO_URL_RE = /^https:\/\/(www\.)?darooyab\.ir\/[^\s?#]{1,200}$/i;
const stripHtml = (s) => String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Find the list of results in an unknown envelope ({result:[…]}, {data:{items:[…]}}, […]).
export function extractItems(body) {
  const stack = [[body, 0]];
  while (stack.length) {
    const [v, d] = stack.shift();
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return v;
    if (v && typeof v === 'object' && d < 4) for (const x of Object.values(v)) stack.push([x, d + 1]);
  }
  return [];
}

const pickStr = (o, re) => {
  for (const [k, v] of Object.entries(o)) if (re.test(k) && typeof v === 'string' && v.trim()) return v.trim();
  return null;
};

export function normalizeSearchItem(o) {
  const url = pickStr(o, /^(url|link|href|page)$/i) ?? Object.values(o).find((v) => typeof v === 'string' && /darooyab\.ir\//i.test(v)) ?? null;
  const fa = pickStr(o, /^(title|name|fa|name_?fa|persian|fa_?name|title_?fa)$/i);
  const en = pickStr(o, /^(en|name_?en|english|en_?name|title_?en|generic)$/i);
  const title = stripHtml(fa ?? en ?? '').slice(0, 160);
  if (!title) return null;
  return {
    title, title_en: en && en !== fa ? stripHtml(en).slice(0, 160) : null,
    subtitle: stripHtml(pickStr(o, /^(desc|description|subtitle|summary|category|type|form)$/i) ?? '').slice(0, 200) || null,
    url: url && INFO_URL_RE.test(url) ? url : null,
  };
}

// Monograph → [{ label, text }] from whatever keys the API uses.
const LABELS_FA = {
  title: 'نام', name: 'نام', en: 'نام انگلیسی', description: 'توضیح', usage: 'موارد مصرف', uses: 'موارد مصرف', indications: 'موارد مصرف',
  dosage: 'مقدار و نحوه مصرف', dose: 'مقدار مصرف', side_effects: 'عوارض جانبی', sideeffects: 'عوارض جانبی', interactions: 'تداخلات دارویی',
  contraindications: 'موارد منع مصرف', warnings: 'هشدارها', pregnancy: 'بارداری و شیردهی', mechanism: 'مکانیسم اثر',
  pharmacology: 'فارماکولوژی', storage: 'شرایط نگهداری', brands: 'نام‌های تجاری', forms: 'اشکال دارویی', category: 'گروه دارویی',
};
export function normalizeInfo(body) {
  const sections = [];
  const seen = new Set();
  const push = (label, text) => {
    const t = stripHtml(text).slice(0, 4000);
    if (!t || t.length < 2 || /^https?:\/\//.test(t) || seen.has(t)) return;
    seen.add(t);
    sections.push({ label: String(label).slice(0, 80), text: t });
  };
  const walk = (v, label, d) => {
    if (d > 4 || sections.length >= 40) return;
    if (typeof v === 'string') return push(label, v);
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string')) return push(label, v.join('\n'));
      for (const x of v) {
        if (x && typeof x === 'object' && (x.title || x.label || x.name) && (x.content || x.text || x.value || x.body)) {
          walk(x.content ?? x.text ?? x.value ?? x.body, x.title ?? x.label ?? x.name, d + 1);
        } else walk(x, label, d + 1);
      }
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/^(status|success|ok|code|message|ok|image|img|thumbnail|icon|url|link|source|dev|developer|channel|token|time)$/i.test(k)) continue;
        walk(x, LABELS_FA[k.toLowerCase()] ?? k, d + 1);
      }
    }
  };
  walk(body, 'اطلاعات', 0);
  return sections;
}

export function createDrugDirectory({ db, config, fetchImpl = globalThis.fetch }) {
  const base = String(config.drugApiBase ?? '').replace(/\/$/, '');
  const enabled = !!base;

  const cached = (key, ttl) => {
    const r = db.get('SELECT value, fetched_at FROM drug_api_cache WHERE key = ?', key);
    return r && Date.now() - Date.parse(r.fetched_at) < ttl ? parseJson(r.value, null) : null;
  };
  const save = (key, value) => db.run(
    `INSERT INTO drug_api_cache (key, value, fetched_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
    key, JSON.stringify(value), nowIso(),
  );

  async function call(path, params) {
    const u = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (config.drugApiToken) u.searchParams.set('token', config.drugApiToken);
    let res;
    try {
      res = await fetchImpl(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      console.error('[drug-api] unreachable:', e.cause?.code ?? e.message);
      throw new ApiError(503, 'drug_api_unavailable', 'سرویس اطلاعات دارو در دسترس نیست');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || body == null) {
      console.error('[drug-api] HTTP', res.status);
      throw new ApiError(502, 'drug_api_error', 'سرویس اطلاعات دارو پاسخ معتبر نداد');
    }
    return body;
  }

  async function search(q) {
    const term = String(q ?? '').trim().slice(0, 60);
    if (!enabled || term.length < 2) return [];
    const key = `s:${term.toLowerCase()}`;
    const hit = cached(key, SEARCH_TTL_MS);
    if (hit) return hit;
    const items = extractItems(await call('search', { search: term })).map(normalizeSearchItem).filter(Boolean).slice(0, 20);
    save(key, items);
    return items;
  }

  async function info(url) {
    if (!enabled) throw new ApiError(503, 'drug_api_unavailable', 'سرویس اطلاعات دارو پیکربندی نشده است');
    if (!INFO_URL_RE.test(String(url ?? ''))) throw badRequest('نشانی دارو نامعتبر است');
    const key = `i:${url}`;
    const hit = cached(key, INFO_TTL_MS);
    if (hit) return hit;
    const out = { url, sections: normalizeInfo(await call('info', { url })) };
    save(key, out);
    return out;
  }

  return { enabled, search, info };
}
