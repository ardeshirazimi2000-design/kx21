// Chest X-ray pattern flags — a RESEARCH aid for the treating physician, never shown to the
// patient and never a diagnosis. Images go to the local CXR service (cxr/cxr_service.py,
// TorchXRayVision DenseNet121 on CPU, 127.0.0.1 only); class-activation overlays mark where the
// model looked. Physicians record agree/disagree per flag so the pilot's real accuracy is known.
import { ApiError, badRequest, notFound, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { requireUser } from './auth.js';

export const CXR_LABELS = {
  Atelectasis: 'آتلکتازی', Consolidation: 'کانسالیدیشن (تراکم)', Infiltration: 'ارتشاح', Pneumothorax: 'پنوموتوراکس',
  Edema: 'ادم ریوی', Emphysema: 'آمفیزم', Fibrosis: 'فیبروز', Effusion: 'افیوژن پلور', Pneumonia: 'الگوی پنومونی',
  Pleural_Thickening: 'ضخیم‌شدگی پلور', Cardiomegaly: 'بزرگی سایه قلب', Nodule: 'ندول', Mass: 'توده', Hernia: 'فتق',
  'Lung Lesion': 'ضایعه ریوی', Fracture: 'شکستگی', 'Lung Opacity': 'کدورت ریوی', 'Enlarged Cardiomediastinum': 'پهن‌شدگی مدیاستن',
};
const QUALITY_FA = {
  not_grayscale: 'تصویر رنگی است؛ احتمالاً رادیوگرافی نیست.',
  low_resolution: 'وضوح تصویر پایین است.',
  unusual_aspect: 'نسبت ابعاد غیرعادی است؛ ممکن است فقط بخشی از قفسه سینه در تصویر باشد.',
  low_contrast: 'کنتراست تصویر کم است.',
  not_cxr_like: 'الگوی کلی تصویر شبیه رادیوگرافی روبه‌روی قفسه سینه نیست (یا تصویر معکوس است)؛ نتیجه قابل اتکا نیست.',
};
const VERDICTS = ['agree', 'disagree', 'unsure'];
export const CXR_DISCLAIMER = 'ابزار کمکی پژوهشی؛ تشخیص نیست و تأیید سازمان غذا و دارو ندارد. «علامت نزدن» به معنی طبیعی بودن تصویر نیست. '
  + 'مدل روی تصاویر اصلی رادیوگرافی آموزش دیده و دقت آن روی عکس گوشی از فیلم یا نگاتوسکوپ کمتر است.';

export function register(router, { db, platform, config, domain, limiter }) {
  const files = domain.files;
  const enabled = () => !!config.cxrUrl;

  const view = (a) => {
    const overlays = parseJson(a.overlay_files, {});
    return {
      id: a.id, record_id: a.record_id, file_id: a.file_id, model: a.model, created_at: a.created_at,
      findings: parseJson(a.findings, []).map((f) => ({ ...f, label: CXR_LABELS[f.key] ?? f.key, overlay_url: overlays[f.key] ? files.signedUrl(overlays[f.key]) : null })),
      quality: parseJson(a.quality, []).map((q) => ({ code: q, message: QUALITY_FA[q] ?? q })),
      feedback: parseJson(a.feedback, null), feedback_note: a.feedback_note, feedback_at: a.feedback_at,
      disclaimer: CXR_DISCLAIMER,
    };
  };

  async function callService(buffer) {
    let res;
    try {
      res = await fetch(`${config.cxrUrl.replace(/\/$/, '')}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer, signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      console.error('[cxr] service unreachable:', e.message);
      throw new ApiError(503, 'cxr_unavailable', 'سرویس تحلیل تصویر در دسترس نیست');
    }
    const body = await res.json().catch(() => null);
    if (res.status === 422) throw badRequest('تصویر قابل خواندن نبود', 'unreadable_image');
    if (!res.ok || !Array.isArray(body?.findings)) throw new ApiError(502, 'cxr_failed', 'تحلیل تصویر ناموفق بود');
    return body;
  }

  router.post('/v1/records/:id/cxr', async (ctx) => {
    requireUser(ctx, 'doctor');
    const r = domain.records.load(ctx, ctx.params.id);
    if (!enabled()) throw new ApiError(503, 'cxr_unavailable', 'تحلیل الگوی عکس قفسه سینه روی این سرور فعال نیست');
    if (ctx.body?.confirm_frontal_cxr !== true) throw badRequest('تأیید کنید که تصویر، رادیوگرافی روبه‌روی (PA/AP) قفسه سینه است', 'confirmation_required');
    const fileId = requireUuid(ctx.body.file_id, 'file_id');
    if (!parseJson(r.file_ids, []).includes(fileId)) throw notFound('فایل');
    const f = db.get('SELECT * FROM files WHERE id = ?', fileId);
    if (!f?.mime.startsWith('image/')) throw badRequest('فقط تصویر (JPG/PNG) قابل تحلیل است');
    limiter.hit(`cxr:${ctx.user.sub}`, 30, 60 * 60 * 1000);
    const out = await callService(files.read(f));
    const overlays = {};
    for (const [key, b64] of Object.entries(out.overlays ?? {})) {
      if (!CXR_LABELS[key]) continue;
      overlays[key] = files.store(ctx, { purpose: 'medical_record', buffer: Buffer.from(b64, 'base64') }).id; // owned by the doctor; reachable only via this analysis
    }
    const findings = out.findings.filter((x) => CXR_LABELS[x.key]).map((x) => ({ key: x.key, score: Number(x.score), tier: ['strong', 'moderate'].includes(x.tier) ? x.tier : 'none' }));
    const id = uuid();
    db.run(
      `INSERT INTO cxr_analyses (id, tenant_id, record_id, file_id, doctor_id, model, findings, quality, overlay_files, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.tenantId, r.id, fileId, ctx.user.did, String(out.model ?? 'unknown'), JSON.stringify(findings),
      JSON.stringify((out.quality ?? []).filter((q) => QUALITY_FA[q])), JSON.stringify(overlays), nowIso(),
    );
    platform.audit(ctx, 'cxr.analyze', `record:${r.id}`, { file_id: fileId, model: out.model, flagged: findings.filter((x) => x.tier !== 'none').map((x) => x.key) });
    return { status: 201, body: view(db.get('SELECT * FROM cxr_analyses WHERE id = ?', id)) };
  });

  router.get('/v1/records/:id/cxr', async (ctx) => {
    requireUser(ctx, 'doctor');
    const r = domain.records.load(ctx, ctx.params.id);
    return { body: { enabled: enabled(), items: db.all('SELECT * FROM cxr_analyses WHERE record_id = ? ORDER BY created_at DESC', r.id).map(view) } };
  });

  // Physician feedback per flag (+ patterns the model missed) — the pilot's ground truth.
  router.post('/v1/cxr/:id/feedback', async (ctx) => {
    requireUser(ctx, 'doctor');
    const a = db.get('SELECT * FROM cxr_analyses WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!a) throw notFound('تحلیل');
    domain.records.load(ctx, a.record_id); // same access rule as the record
    const b = ctx.body ?? {};
    const flagged = parseJson(a.findings, []).filter((x) => x.tier !== 'none').map((x) => x.key);
    const verdicts = {};
    for (const [k, v] of Object.entries(b.verdicts ?? {})) {
      if (!flagged.includes(k) || !VERDICTS.includes(v)) throw badRequest('نظر نامعتبر است');
      verdicts[k] = v;
    }
    const missed = [...new Set((Array.isArray(b.missed) ? b.missed : []).filter((k) => CXR_LABELS[k] && !flagged.includes(k)))];
    const fb = { verdicts, missed, overall: ['useful', 'not_useful'].includes(b.overall) ? b.overall : null };
    db.run('UPDATE cxr_analyses SET feedback = ?, feedback_note = ?, feedback_at = ? WHERE id = ?',
      JSON.stringify(fb), String(b.note ?? '').trim().slice(0, 1000) || null, nowIso(), a.id);
    platform.audit(ctx, 'cxr.feedback', `cxr:${a.id}`, fb);
    return { body: view(db.get('SELECT * FROM cxr_analyses WHERE id = ?', a.id)) };
  });

  // Pilot statistics for the clinic (admin).
  router.get('/v1/admin/cxr-stats', async (ctx) => {
    domain.access.require(ctx, 'stats.view');
    const rows = db.all('SELECT findings, feedback FROM cxr_analyses WHERE tenant_id = ?', ctx.tenantId);
    const per = Object.fromEntries(Object.keys(CXR_LABELS).map((k) => [k, { key: k, label: CXR_LABELS[k], flagged: 0, agree: 0, disagree: 0, unsure: 0, missed: 0 }]));
    let reviewed = 0;
    let useful = 0;
    for (const r of rows) {
      for (const f of parseJson(r.findings, [])) if (f.tier !== 'none' && per[f.key]) per[f.key].flagged++;
      const fb = parseJson(r.feedback, null);
      if (!fb) continue;
      reviewed++;
      if (fb.overall === 'useful') useful++;
      for (const [k, v] of Object.entries(fb.verdicts ?? {})) if (per[k]) per[k][v]++;
      for (const k of fb.missed ?? []) if (per[k]) per[k].missed++;
    }
    const items = Object.values(per).filter((p) => p.flagged || p.missed).map((p) => ({
      ...p, agreement: p.agree + p.disagree ? Math.round((p.agree / (p.agree + p.disagree)) * 100) : null,
    }));
    return { body: { enabled: enabled(), analyses: rows.length, reviewed, useful, items } };
  });
}
