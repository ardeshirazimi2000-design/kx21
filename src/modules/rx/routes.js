// Prescriber tools: ICD-10 code search, drug-name suggestions, and each doctor's own
// prescription templates ("my usual prescriptions", optionally tied to a diagnosis code).
import { badRequest, notFound, requireUuid } from '../../lib/http.js';
import { uuid, nowIso, parseJson } from '../../lib/db.js';
import { requireUser } from '../auth.js';
import { searchIcd, icdByCode, ICD10_VERSION } from './icd10.js';
import { drugSuggestions, identifyDrug, DRUG_KB_VERSION } from './drug-kb.js';

const MAX_TEMPLATES = 200;

export function register(router, { db, platform, domain, limiter }) {
  router.get('/v1/icd10', async (ctx) => {
    requireUser(ctx, 'doctor');
    return { body: { version: ICD10_VERSION, items: searchIcd(String(ctx.query.q ?? '').slice(0, 60)) } };
  });

  // Without q: names known to the safety checks (for autocomplete). With q: also the external
  // drug directory, marked with whether the safety checks recognise each name.
  router.get('/v1/drugs', async (ctx) => {
    requireUser(ctx, 'doctor');
    const q = String(ctx.query.q ?? '').trim();
    if (!q) return { body: { version: DRUG_KB_VERSION, items: drugSuggestions(), directory: domain.drugDirectory.enabled } };
    limiter.hit(`drugs:${ctx.user.sub}`, 120, 60_000);
    const local = drugSuggestions().filter((n) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
    let remote = [];
    let remoteError = null;
    try {
      remote = await domain.drugDirectory.search(q);
    } catch (e) {
      remoteError = e.message;
    }
    return {
      body: {
        version: DRUG_KB_VERSION, items: local, directory: domain.drugDirectory.enabled, directory_error: remoteError,
        directory_items: remote.map((r) => ({ ...r, safety_checked: !!(identifyDrug(r.title) || (r.title_en && identifyDrug(r.title_en))) })),
      },
    };
  });

  // Monograph from the drug directory — reference text for the prescriber, with its source.
  router.get('/v1/drugs/info', async (ctx) => {
    requireUser(ctx, 'doctor');
    limiter.hit(`drugs:${ctx.user.sub}`, 120, 60_000);
    const r = await domain.drugDirectory.info(ctx.query.url);
    return { body: { ...r, source: 'داروياب (darooyab.ir) از طریق سرویس واسط', disclaimer: 'متن مرجع عمومی؛ پیش از تصمیم درمانی با منابع معتبر بالینی تطبیق دهید. در بررسی ایمنی خودکار استفاده نمی‌شود.' } };
  });

  const clean = (b) => {
    const name = String(b.name ?? '').trim();
    if (name.length < 2 || name.length > 80) throw badRequest('نام الگو را وارد کنید (حداکثر ۸۰ حرف)');
    const code = b.diagnosis_code ? icdByCode(b.diagnosis_code)?.code : null;
    if (b.diagnosis_code && !code) throw badRequest('کد ICD-10 شناخته نشد', 'unknown_icd_code');
    if (!Array.isArray(b.drugs) || !b.drugs.length || b.drugs.length > 20) throw badRequest('الگو باید حداقل یک دارو داشته باشد');
    const pick = (d, k) => (d[k] == null || d[k] === '' ? null : String(d[k]).slice(0, 200));
    const drugs = b.drugs.filter((d) => d && String(d.name ?? '').trim()).map((d) => ({
      name: String(d.name).trim().slice(0, 200), dose: pick(d, 'dose'), frequency: pick(d, 'frequency'), duration: pick(d, 'duration'), instructions: pick(d, 'instructions'),
      ...(d.erx_code && /^\d{1,10}$/.test(String(d.erx_code)) ? { erx_code: String(d.erx_code) } : {}),
    }));
    if (!drugs.length) throw badRequest('الگو باید حداقل یک دارو داشته باشد');
    return { name, code, drugs, notes: b.notes ? String(b.notes).slice(0, 2000) : null };
  };
  const view = (t) => {
    const dx = t.diagnosis_code ? icdByCode(t.diagnosis_code) : null;
    return {
      id: t.id, name: t.name, diagnosis_code: t.diagnosis_code, diagnosis_label: dx?.label_fa ?? null,
      drugs: parseJson(t.drugs, []), notes: t.notes, use_count: t.use_count, updated_at: t.updated_at,
    };
  };
  const mine = (ctx, id) => {
    const t = db.get('SELECT * FROM rx_templates WHERE id = ? AND doctor_id = ?', requireUuid(id, 'id'), ctx.user.did);
    if (!t) throw notFound('الگو');
    return t;
  };

  router.get('/v1/doctors/me/rx-templates', async (ctx) => {
    requireUser(ctx, 'doctor');
    const code = ctx.query.diagnosis_code ? String(ctx.query.diagnosis_code) : null;
    // Templates for the chosen diagnosis first, then the most used.
    const rows = db.all(
      `SELECT * FROM rx_templates WHERE doctor_id = ? ORDER BY (diagnosis_code = ?) DESC, use_count DESC, updated_at DESC LIMIT ${MAX_TEMPLATES}`,
      ctx.user.did, code ?? '-',
    );
    return { body: { items: rows.map(view) } };
  });

  router.post('/v1/doctors/me/rx-templates', async (ctx) => {
    requireUser(ctx, 'doctor');
    const c = clean(ctx.body ?? {});
    if (db.get('SELECT COUNT(*) AS n FROM rx_templates WHERE doctor_id = ?', ctx.user.did).n >= MAX_TEMPLATES) throw badRequest('حداکثر تعداد الگو ثبت شده است');
    const id = uuid();
    const now = nowIso();
    db.run('INSERT INTO rx_templates (id, tenant_id, doctor_id, name, diagnosis_code, drugs, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, ctx.user.did, c.name, c.code, JSON.stringify(c.drugs), c.notes, now, now);
    platform.audit(ctx, 'rx_template.create', `rx_template:${id}`);
    return { status: 201, body: view(db.get('SELECT * FROM rx_templates WHERE id = ?', id)) };
  });

  router.put('/v1/doctors/me/rx-templates/:id', async (ctx) => {
    requireUser(ctx, 'doctor');
    const t = mine(ctx, ctx.params.id);
    const c = clean({ ...view(t), ...ctx.body });
    db.run('UPDATE rx_templates SET name = ?, diagnosis_code = ?, drugs = ?, notes = ?, updated_at = ? WHERE id = ?',
      c.name, c.code, JSON.stringify(c.drugs), c.notes, nowIso(), t.id);
    return { body: view(db.get('SELECT * FROM rx_templates WHERE id = ?', t.id)) };
  });

  // Counts usage so the most used templates come first.
  router.post('/v1/doctors/me/rx-templates/:id/use', async (ctx) => {
    requireUser(ctx, 'doctor');
    const t = mine(ctx, ctx.params.id);
    db.run('UPDATE rx_templates SET use_count = use_count + 1 WHERE id = ?', t.id);
    return { body: view(db.get('SELECT * FROM rx_templates WHERE id = ?', t.id)) };
  });

  router.delete('/v1/doctors/me/rx-templates/:id', async (ctx) => {
    requireUser(ctx, 'doctor');
    const t = mine(ctx, ctx.params.id);
    db.run('DELETE FROM rx_templates WHERE id = ?', t.id);
    platform.audit(ctx, 'rx_template.delete', `rx_template:${t.id}`);
    return { status: 204 };
  });
}
