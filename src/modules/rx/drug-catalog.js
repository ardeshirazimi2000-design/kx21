// National drug coding (eRx-IRC, Iran FDA): the admin uploads the official Excel file
// ("کدینگ نسخه نویسی و نسخه پیچی")، reviews a preview, then activates it. Prescribers then pick
// drugs with their official eRx code; deleted codes are refused with their replacement.
// Each upload is kept as a version, so the clinic can roll back. Data stays on this server.
import crypto from 'node:crypto';
import { ApiError, badRequest, notFound, requireUuid } from '../../lib/http.js';
import { uuid, nowIso, parseJson } from '../../lib/db.js';
import { readXlsx } from '../../lib/xlsx.js';
import { normalizeFa } from '../../lib/fa.js';
import { requireUser } from '../auth.js';
import { identifyDrug, DRUGS } from './drug-kb.js';
import { matchPersian, buildIndex } from './fa-translit.js';

const MAX_UPLOAD = 25 * 1024 * 1024;
const FORMS = ['TABLET', 'CAPSULE', 'INJECTION', 'SYRUP', 'SUSPENSION', 'SOLUTION', 'CREAM', 'OINTMENT', 'DROPS', 'SPRAY', 'SUPPOSITORY',
  'POWDER', 'GEL', 'INHALER', 'AEROSOL', 'PATCH', 'LOTION', 'GRANULE', 'ELIXIR', 'EMULSION', 'SHAMPOO', 'KIT', 'LOZENGE', 'FOAM', 'PASTE'];
const FORM_RE = new RegExp(`\\b(${FORMS.join('|')})\\b`);
const STRENGTH_RE = /\s(\d[\d.,]*\s*(mg|g|mcg|ug|µg|%|\[iU\]|iu|unit|units|ml|mmol|meq|million|{)|\d[\d.,]*\s*\/)/i;

/** "AMOXICILLIN 500 mg CAPSULE ORAL [AFAMOX]" → { generic, brand, form } */
export function parseErxTitle(title) {
  const t = String(title ?? '').trim();
  const brand = t.match(/\[([^\]]+)\]\s*$/)?.[1]?.trim() ?? null;
  const base = brand ? t.slice(0, t.lastIndexOf('[')).trim() : t;
  const m = STRENGTH_RE.exec(base);
  let generic = (m ? base.slice(0, m.index) : base.replace(FORM_RE, '').replace(/\b(ORAL|PARENTERAL|TOPICAL|NASAL|OPHTHALMIC|RECTAL|VAGINAL)\b.*$/, '')).trim();
  generic = generic.replace(/\s*\((AS|EQ)\b[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
  return { generic, brand, form: base.match(FORM_RE)?.[1] ?? null };
}

const findCol = (header, ...names) => header.findIndex((h) => names.some((n) => String(h).trim().toLowerCase() === n.toLowerCase()));

/** Excel buffer → parsed catalogue with validation issues. */
export function parseCatalog(buf) {
  let sheets;
  try {
    sheets = readXlsx(buf);
  } catch (e) {
    throw badRequest(`فایل اکسل قابل خواندن نیست (${e.message})`, 'invalid_xlsx');
  }
  // Sheets are recognised by their header columns, not their names.
  const pick = (pred) => sheets.find((s) => s.rows.length && pred(s.rows[0]));
  const rxSheet = pick((h) => findCol(h, 'ERXCode') === 0 && findCol(h, 'ErxTitle') >= 0 && findCol(h, 'GenericCode') >= 0)
    ?? pick((h) => findCol(h, 'ERXCode') >= 0 && findCol(h, 'ErxTitle') >= 0 && findCol(h, 'GenericCode') >= 0 && findCol(h, 'IRC') < 0);
  if (!rxSheet) throw badRequest('برگه «کدینگ نسخه نویسی» با ستون‌های ERXCode، ErxTitle و GenericCode پیدا نشد', 'missing_sheet');
  const dispSheet = pick((h) => findCol(h, 'IRC') >= 0 && findCol(h, 'ErxCode') >= 0);
  const delSheet = pick((h) => findCol(h, 'ERXCode') >= 0 && h.some((x) => /جایگزین|replace/i.test(String(x))));

  const h = rxSheet.rows[0];
  const c = { code: findCol(h, 'ERXCode'), title: findCol(h, 'ErxTitle'), generic: findCol(h, 'GenericCode'), action: findCol(h, 'Action') };
  const items = new Map();
  const issues = [];
  let duplicates = 0;
  for (const [i, r] of rxSheet.rows.slice(1).entries()) {
    const code = String(r[c.code] ?? '').trim();
    const title = String(r[c.title] ?? '').trim();
    if (!code && !title) continue;
    if (!/^\d{1,10}$/.test(code) || !title) { if (issues.length < 50) issues.push(`ردیف ${i + 2}: کد یا عنوان نامعتبر`); continue; }
    if (items.has(code)) { duplicates++; continue; }
    const p = parseErxTitle(title);
    items.set(code, {
      erx_code: code, title: title.slice(0, 400), generic_code: String(r[c.generic] ?? '').trim() || null,
      generic_name: p.generic.slice(0, 200), brand: p.brand, form: p.form, action: c.action >= 0 ? String(r[c.action] ?? '').trim() || null : null,
    });
  }
  if (items.size < 10) throw badRequest('تعداد ردیف‌های معتبر فهرست دارو کمتر از حد انتظار است', 'too_few_rows');

  const packCount = new Map();
  if (dispSheet) {
    const dc = findCol(dispSheet.rows[0], 'ErxCode');
    for (const r of dispSheet.rows.slice(1)) {
      const k = String(r[dc] ?? '').trim();
      if (k) packCount.set(k, (packCount.get(k) ?? 0) + 1);
    }
  }
  const deleted = [];
  if (delSheet) {
    const dh = delSheet.rows[0];
    const dcode = findCol(dh, 'ERXCode');
    const dtitle = findCol(dh, 'ErxTitle');
    const drep = dh.findIndex((x) => /جایگزین|replace/i.test(String(x)));
    for (const r of delSheet.rows.slice(1)) {
      const code = String(r[dcode] ?? '').trim();
      if (code) deleted.push({ erx_code: code, title: String(r[dtitle] ?? '').trim(), replacement: String(r[drep] ?? '').trim() || null });
    }
  }
  const generics = new Set([...items.values()].map((x) => x.generic_name));
  const covered = [...generics].filter((g) => identifyDrug(g)).length;
  const actions = {};
  for (const x of items.values()) if (x.action) actions[x.action] = (actions[x.action] ?? 0) + 1;
  return {
    items: [...items.values()].map((x) => ({ ...x, packs: packCount.get(x.erx_code) ?? 0 })),
    deleted,
    summary: {
      prescribing_rows: items.size, generic_names: generics.size, dispensing_rows: dispSheet ? dispSheet.rows.length - 1 : 0,
      deleted: deleted.length, duplicates, actions, safety_covered_generics: covered,
      sheets: { prescribing: rxSheet.name, dispensing: dispSheet?.name ?? null, deleted: delSheet?.name ?? null },
    },
    issues,
  };
}

const normQ = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9./% -]+/g, ' ').replace(/\s+/g, ' ').trim();

export function createDrugCatalog({ db }) {
  const active = (tenantId) => db.get(`SELECT * FROM drug_catalogs WHERE tenant_id = ? AND status = 'active'`, tenantId);

  // Persian input: (1) the curated aliases of the local drug KB (e.g. آسپرین → ASA / ACETYLSALICYLIC
  // ACID), then (2) phonetic matching against every generic name of the catalogue (متفورمین → METFORMIN).
  function kbEnglishNames(q) {
    const n = normalizeFa(q);
    if (n.length < 3) return [];
    const hits = DRUGS.filter((d) => d.names.some((x) => normalizeFa(x).startsWith(n) || normalizeFa(x).includes(` ${n}`)));
    return [...new Set(hits.flatMap((d) => d.names.filter((x) => /^[a-z0-9 ./-]+$/i.test(x)).map((x) => x.toUpperCase())))].slice(0, 8);
  }
  const indexCache = new Map();
  const indexFor = (catalogId) => {
    if (!indexCache.has(catalogId)) {
      indexCache.clear();
      indexCache.set(catalogId, buildIndex(db.all('SELECT DISTINCT generic_name FROM erx_items WHERE catalog_id = ?', catalogId).map((r) => r.generic_name)));
    }
    return indexCache.get(catalogId);
  };

  function search(tenantId, q, limit = 20) {
    const cat = active(tenantId);
    if (!cat) return { catalog: null, items: [] };
    const seen = new Set();
    const out = [];
    const take = (rows) => { for (const r of rows) if (!seen.has(r.erx_code)) { seen.add(r.erx_code); out.push(r); } };
    const byGeneric = (where, arg, n) => db.all(
      `SELECT * FROM erx_items WHERE catalog_id = ? AND ${where} ORDER BY (brand IS NULL) DESC, length(title) LIMIT ?`, cat.id, arg, n,
    );
    let matchedBy = 'text';
    if (/[؀-ۿ]/.test(q)) {
      matchedBy = 'persian';
      // Single-ingredient products before combinations (آسپرین → ASA before ASA / CLOPIDOGREL).
      const kbRows = kbEnglishNames(q).flatMap((name) => byGeneric('generic_name LIKE ?', `${name}%`, 6));
      take(kbRows.sort((a, b) => (a.generic_name.includes('/') - b.generic_name.includes('/')) || (a.title.length - b.title.length)));
      for (const g of matchPersian(q, indexFor(cat.id), 5)) take(byGeneric('generic_name = ?', g, 5));
    } else {
      const query = normQ(q);
      if (/^\d{4,6}$/.test(query)) {
        take(db.all('SELECT * FROM erx_items WHERE catalog_id = ? AND erx_code = ?', cat.id, query));
      } else if (query.length >= 2) {
        const toks = query.split(' ').filter(Boolean).slice(0, 5);
        take(db.all(
          `SELECT * FROM erx_items WHERE catalog_id = ? ${toks.map(() => 'AND title LIKE ?').join(' ')}
           ORDER BY (generic_name LIKE ?) DESC, (brand IS NULL) DESC, length(title) LIMIT ?`,
          cat.id, ...toks.map((t) => `%${t}%`), `${toks[0]}%`, limit,
        ));
      }
    }
    return {
      catalog: { id: cat.id, filename: cat.filename, activated_at: cat.activated_at }, matched_by: matchedBy,
      items: out.slice(0, limit).map((r) => ({
        erx_code: r.erx_code, title: r.title, generic_name: r.generic_name, brand: r.brand, form: r.form, packs: r.packs,
        safety_checked: !!identifyDrug(r.generic_name),
      })),
    };
  }

  // Prescription item → official code check. Returns the catalogue row or throws.
  function resolve(tenantId, erxCode) {
    const cat = active(tenantId);
    if (!cat) throw badRequest('فهرست رسمی داروها فعال نیست؛ کد eRx قابل استفاده نیست', 'no_drug_catalog');
    const code = String(erxCode).trim();
    const r = db.get('SELECT * FROM erx_items WHERE catalog_id = ? AND erx_code = ?', cat.id, code);
    if (r) return r;
    const del = db.get('SELECT * FROM erx_deleted WHERE catalog_id = ? AND erx_code = ?', cat.id, code);
    if (del) throw badRequest(`کد eRx ${code} حذف شده است${del.replacement ? `؛ کد جایگزین: ${del.replacement}` : ''}`, 'erx_code_deleted');
    throw badRequest(`کد eRx ${code} در فهرست رسمی فعال نیست`, 'unknown_erx_code');
  }

  return { active, search, resolve };
}

export function register(router, { db, platform, domain }) {
  const view = (c) => ({
    id: c.id, filename: c.filename, status: c.status, summary: parseJson(c.summary, {}), issues: parseJson(c.issues, []),
    created_at: c.created_at, activated_at: c.activated_at, sha256: c.sha256,
  });

  // Upload (raw .xlsx body) → staged version with a preview; nothing changes until activation.
  router.post('/v1/admin/drug-catalog', async (ctx) => {
    domain.access.require(ctx, 'drug_catalog.manage');
    const chunks = [];
    let size = 0;
    for await (const ch of ctx.req) {
      size += ch.length;
      if (size > MAX_UPLOAD) throw new ApiError(413, 'file_too_large', 'حداکثر حجم فایل ۲۵ مگابایت است');
      chunks.push(ch);
    }
    const buf = Buffer.concat(chunks);
    if (buf.subarray(0, 2).toString() !== 'PK') throw badRequest('فقط فایل اکسل (xlsx) پذیرفته می‌شود؛ اگر فایل فشرده (rar/zip) است ابتدا آن را باز کنید', 'invalid_xlsx');
    const parsed = parseCatalog(buf);
    const id = uuid();
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    db.tx(() => {
      db.run(`DELETE FROM erx_items WHERE catalog_id IN (SELECT id FROM drug_catalogs WHERE tenant_id = ? AND status = 'staged')`, ctx.tenantId);
      db.run(`DELETE FROM erx_deleted WHERE catalog_id IN (SELECT id FROM drug_catalogs WHERE tenant_id = ? AND status = 'staged')`, ctx.tenantId);
      db.run(`DELETE FROM drug_catalogs WHERE tenant_id = ? AND status = 'staged'`, ctx.tenantId);
      db.run(`INSERT INTO drug_catalogs (id, tenant_id, filename, sha256, status, summary, issues, created_by, created_at) VALUES (?,?,?,?, 'staged', ?,?,?,?)`,
        id, ctx.tenantId, String(ctx.query.filename ?? 'drug-coding.xlsx').slice(0, 200), sha, JSON.stringify(parsed.summary), JSON.stringify(parsed.issues), ctx.user.sub, nowIso());
      for (const x of parsed.items) {
        db.run(`INSERT INTO erx_items (catalog_id, erx_code, title, generic_code, generic_name, brand, form, action, packs) VALUES (?,?,?,?,?,?,?,?,?)`,
          id, x.erx_code, x.title, x.generic_code, x.generic_name, x.brand, x.form, x.action, x.packs);
      }
      for (const d of parsed.deleted) {
        db.run('INSERT OR REPLACE INTO erx_deleted (catalog_id, erx_code, title, replacement) VALUES (?,?,?,?)', id, d.erx_code, d.title, d.replacement);
      }
    });
    platform.audit(ctx, 'drug_catalog.upload', `drug_catalog:${id}`, { sha256: sha, rows: parsed.summary.prescribing_rows });
    const sample = db.all('SELECT erx_code, title, generic_name, brand, form FROM erx_items WHERE catalog_id = ? ORDER BY random() LIMIT 8', id);
    return { status: 201, body: { ...view(db.get('SELECT * FROM drug_catalogs WHERE id = ?', id)), sample } };
  });

  router.get('/v1/admin/drug-catalog', async (ctx) => {
    domain.access.require(ctx, 'drug_catalog.manage');
    return { body: { items: db.all('SELECT * FROM drug_catalogs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20', ctx.tenantId).map(view) } };
  });

  // Activate a staged version or roll back to an archived one.
  router.post('/v1/admin/drug-catalog/:id/activate', async (ctx) => {
    domain.access.require(ctx, 'drug_catalog.manage');
    const c = db.get('SELECT * FROM drug_catalogs WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!c) throw notFound('فهرست دارو');
    db.tx(() => {
      db.run(`UPDATE drug_catalogs SET status = 'archived' WHERE tenant_id = ? AND status = 'active'`, ctx.tenantId);
      db.run(`UPDATE drug_catalogs SET status = 'active', activated_at = ? WHERE id = ?`, nowIso(), c.id);
    });
    platform.audit(ctx, 'drug_catalog.activate', `drug_catalog:${c.id}`, { sha256: c.sha256 });
    return { body: view(db.get('SELECT * FROM drug_catalogs WHERE id = ?', c.id)) };
  });

  router.get('/v1/drug-catalog/search', async (ctx) => {
    if (requireUser(ctx).role !== 'doctor') domain.access.require(ctx, 'drug_catalog.manage');
    return { body: domain.drugCatalog.search(ctx.tenantId, String(ctx.query.q ?? '').slice(0, 80)) };
  });
}
