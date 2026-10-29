// Patient medical documents sent to a doctor, grouped by category (lab results, imaging, …),
// plus the AI "pre-read" for the doctor and the doctor's final opinion back to the patient.
// Access: the patient who owns them; the doctor of the appointment they were shared with.
import { ApiError, badRequest, notFound, forbidden, conflict, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { requireUser } from './auth.js';
import { reviewLabRows, summarizeFindings, LAB_REVIEW_VERSION } from './ai/lab-review.js';
import { checkOutput } from './ai/guardrails.js';

export const RECORD_CATEGORIES = {
  lab: 'نتیجه آزمایش', imaging: 'تصاویر پزشکی (رادیولوژی، سونوگرافی، MRI…)', report: 'گزارش پزشکی / خلاصه پرونده',
  prescription: 'نسخه یا داروهای قبلی', other: 'سایر',
};

export function register(router, { db, platform, config, domain, limiter }) {
  const files = domain.files;

  const patientOf = (ctx) => {
    requireUser(ctx, 'patient');
    const p = domain.patient.patientByUser(ctx.user.sub);
    if (!p) throw forbidden('ابتدا پروفایل خود را تکمیل کنید', 'profile_incomplete');
    return p;
  };

  const load = (ctx, id) => {
    const r = db.get('SELECT * FROM medical_records WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', requireUuid(id, 'id'), ctx.tenantId);
    if (!r) throw notFound('مدرک');
    const u = ctx.user;
    if (u.role === 'patient') {
      if (domain.patient.patientByUser(u.sub)?.id !== r.patient_id) throw notFound('مدرک');
    } else if (u.role === 'doctor') {
      const a = r.appointment_id && db.get('SELECT doctor_id FROM appointments WHERE id = ?', r.appointment_id);
      if (!a || a.doctor_id !== u.did) throw notFound('مدرک');
    } else throw forbidden();
    return r;
  };

  const view = (r, role) => ({
    id: r.id, appointment_id: r.appointment_id, category: r.category, category_label: RECORD_CATEGORIES[r.category],
    title: r.title, note: r.note, lab_rows: parseJson(r.lab_rows, []),
    files: parseJson(r.file_ids, []).map((id) => { const m = files.meta(id); return m && { id, mime: m.mime, url: files.signedUrl(id) }; }).filter(Boolean),
    // the AI draft is for the physician only
    ai_review: role === 'doctor' ? parseJson(r.ai_review, null) : undefined,
    doctor_opinion: r.doctor_opinion, opinion_at: r.opinion_at, created_at: r.created_at,
  });

  domain.records = { load };

  router.get('/v1/records/categories', async () => ({
    body: { items: Object.entries(RECORD_CATEGORIES).map(([code, label]) => ({ code, label })) },
  }));

  router.post('/v1/records', async (ctx) => {
    const p = patientOf(ctx);
    const b = ctx.body;
    if (!RECORD_CATEGORIES[b.category]) throw badRequest('دسته‌بندی مدرک نامعتبر است');
    const title = String(b.title ?? '').trim();
    if (title.length < 2 || title.length > 120) throw badRequest('عنوان مدرک را وارد کنید');
    const fileIds = Array.isArray(b.file_ids) ? b.file_ids : [];
    if (fileIds.length > 10) throw badRequest('حداکثر ۱۰ فایل برای هر مدرک');
    for (const id of fileIds) {
      const f = files.meta(requireUuid(id, 'file_id'));
      if (!f || f.owner_user_id !== ctx.user.sub || f.purpose !== 'medical_record') throw badRequest('فایل نامعتبر است', 'invalid_file');
    }
    const rows = (Array.isArray(b.lab_rows) ? b.lab_rows : []).slice(0, 60)
      .map((r) => ({
        name: String(r?.name ?? '').trim().slice(0, 60), value: String(r?.value ?? '').trim().slice(0, 20), unit: String(r?.unit ?? '').trim().slice(0, 20), ref: String(r?.ref ?? '').trim().slice(0, 30),
        ...(r?.ocr ? { ocr: true } : {}), // read from the photo and confirmed by the patient
      }))
      .filter((r) => r.name && r.value);
    if (!fileIds.length && !rows.length && !String(b.note ?? '').trim()) throw badRequest('حداقل یک فایل، متن یا مقدار آزمایش اضافه کنید');
    let apptId = null;
    if (b.appointment_id) {
      const a = db.get('SELECT * FROM appointments WHERE id = ? AND patient_id = ?', requireUuid(b.appointment_id, 'appointment_id'), p.id);
      if (!a || !['pending', 'confirmed', 'completed'].includes(a.status)) throw badRequest('نوبت انتخاب‌شده نامعتبر است');
      apptId = a.id;
    }
    const id = uuid();
    db.run(
      `INSERT INTO medical_records (id, tenant_id, patient_id, appointment_id, category, title, note, lab_rows, file_ids, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.tenantId, p.id, apptId, b.category, title, String(b.note ?? '').trim().slice(0, 4000) || null,
      JSON.stringify(rows), JSON.stringify(fileIds), nowIso(),
    );
    platform.audit(ctx, 'record.create', `record:${id}`, { category: b.category, files: fileIds.length, appointment_id: apptId });
    if (apptId) {
      const d = db.get('SELECT u.id, u.phone FROM appointments a JOIN doctors d ON d.id = a.doctor_id JOIN users u ON u.id = d.user_id WHERE a.id = ?', apptId);
      if (d) platform.notify(ctx, { userId: d.id, channel: 'push', target: d.phone, body: `بیمار مدرک جدیدی ارسال کرد: ${RECORD_CATEGORIES[b.category]} — ${title}` });
    }
    return { status: 201, body: view(db.get('SELECT * FROM medical_records WHERE id = ?', id), 'patient') };
  });

  // Lab sheet photo/PDF → suggested rows for the patient to check before sending.
  router.post('/v1/records/ocr', async (ctx) => {
    patientOf(ctx);
    const ids = Array.isArray(ctx.body.file_ids) ? ctx.body.file_ids.slice(0, 4) : [];
    if (!ids.length) throw badRequest('ابتدا عکس یا PDF برگه آزمایش را اضافه کنید');
    const list = ids.map((id) => {
      const f = files.meta(requireUuid(id, 'file_id'));
      if (!f || f.owner_user_id !== ctx.user.sub || f.purpose !== 'medical_record') throw badRequest('فایل نامعتبر است', 'invalid_file');
      return db.get('SELECT * FROM files WHERE id = ?', id);
    });
    if (!(await domain.labOcr.isAvailable())) {
      throw new ApiError(503, 'ocr_unavailable', 'خواندن خودکار روی سرور فعال نیست؛ مقادیر را دستی وارد کنید');
    }
    limiter.hitShared(`ocr:${ctx.user.sub}`, 20, 60 * 60 * 1000);
    let result;
    try {
      result = await domain.labOcr.extract(await Promise.all(list.map(async (f) => ({ mime: f.mime, data: await files.read(f) }))));
    } catch (e) {
      if (e.code === 'busy') throw new ApiError(429, 'ocr_busy', 'سرور در حال خواندن برگه‌های دیگر است؛ چند ثانیه بعد دوباره تلاش کنید');
      console.error('[lab-ocr] failed:', e.message);
      throw new ApiError(422, 'ocr_failed', 'خواندن فایل ممکن نشد؛ عکس واضح‌تری بگیرید یا مقادیر را دستی وارد کنید');
    }
    platform.audit(ctx, 'record.ocr', `user:${ctx.user.sub}`, { files: list.length, rows: result.rows.length, engine: result.engine });
    return { body: { rows: result.rows.map(({ line, ...r }) => r), engine: result.engine, version: result.version } };
  });

  router.get('/v1/records', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    let rows;
    if (ctx.user.role === 'patient') {
      const p = patientOf(ctx);
      rows = db.all('SELECT * FROM medical_records WHERE patient_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200', p.id);
    } else {
      const apptId = requireUuid(ctx.query.appointment_id, 'appointment_id');
      const a = db.get('SELECT doctor_id FROM appointments WHERE id = ?', apptId);
      if (!a || a.doctor_id !== ctx.user.did) throw notFound('نوبت');
      rows = db.all('SELECT * FROM medical_records WHERE appointment_id = ? AND deleted_at IS NULL ORDER BY created_at', apptId);
      platform.audit(ctx, 'record.read', `appointment:${apptId}`, { count: rows.length });
    }
    return { body: { items: rows.map((r) => view(r, ctx.user.role)) } };
  });

  router.delete('/v1/records/:id', async (ctx) => {
    const r = load(ctx, ctx.params.id);
    if (ctx.user.role !== 'patient') throw forbidden();
    if (r.doctor_opinion) throw conflict('مدرکی که پزشک درباره آن نظر داده قابل حذف نیست', 'has_opinion');
    db.run('UPDATE medical_records SET deleted_at = ? WHERE id = ?', nowIso(), r.id);
    platform.audit(ctx, 'record.delete', `record:${r.id}`);
    return { status: 204 };
  });

  // AI pre-read for the doctor: lab values against reference ranges and, when a self-hosted
  // vision model is configured, a description of the uploaded images. Draft only.
  router.post('/v1/records/:id/ai-review', async (ctx) => {
    requireUser(ctx, 'doctor');
    const r = load(ctx, ctx.params.id);
    const sex = db.get('SELECT p.gender FROM patients p WHERE p.id = ?', r.patient_id)?.gender;
    const parts = [];
    const rows = parseJson(r.lab_rows, []);
    let findings = [];
    if (rows.length) {
      findings = reviewLabRows(rows, { sex });
      parts.push(summarizeFindings(findings));
    }
    let model = null;
    const fileIds = parseJson(r.file_ids, []);
    const images = fileIds.map((id) => db.get('SELECT * FROM files WHERE id = ?', id)).filter((f) => f && f.mime.startsWith('image/'));
    if (images.length) {
      if (config.visionLlmBaseUrl) {
        const text = await describeImages(config, await Promise.all(images.slice(0, 4).map(async (f) => ({ mime: f.mime, data: await files.read(f) }))), r);
        if (text) { parts.push(`خوانش تصویر (پیش‌نویس مدل ${config.visionLlmModel}):\n${text}`); model = config.visionLlmModel; }
        else parts.push('مدل تصویری پاسخ نداد؛ تصاویر را مستقیم بررسی کنید.');
      } else {
        parts.push(`${images.length} تصویر پیوست شده است. مدل تفسیر تصویر روی سرور فعال نیست؛ تصاویر را مستقیم بررسی کنید.`);
      }
    }
    if (!parts.length) parts.push('داده‌ای برای تفسیر خودکار وجود ندارد (بدون مقدار آزمایش یا تصویر).');
    const review = {
      text: parts.join('\n\n'), findings, model, rule_version: LAB_REVIEW_VERSION, at: nowIso(),
      disclaimer: 'پیش‌نویس خودکار برای پزشک؛ تشخیص یا نظر نهایی نیست.',
    };
    db.run('UPDATE medical_records SET ai_review = ? WHERE id = ?', JSON.stringify(review), r.id);
    platform.audit(ctx, 'record.ai_review', `record:${r.id}`, { lab_rows: rows.length, images: images.length, model });
    return { body: view(db.get('SELECT * FROM medical_records WHERE id = ?', r.id), 'doctor') };
  });

  router.post('/v1/records/:id/opinion', async (ctx) => {
    requireUser(ctx, 'doctor');
    const r = load(ctx, ctx.params.id);
    const text = String(ctx.body.opinion ?? '').trim();
    if (text.length < 5 || text.length > 4000) throw badRequest('نظر پزشک را بنویسید');
    db.run('UPDATE medical_records SET doctor_opinion = ?, opinion_by = ?, opinion_at = ? WHERE id = ?', text, ctx.user.did, nowIso(), r.id);
    platform.audit(ctx, 'record.opinion', `record:${r.id}`);
    const pu = db.get('SELECT u.id, u.phone FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', r.patient_id);
    if (pu) platform.notify(ctx, { userId: pu.id, channel: 'sms', target: pu.phone, body: `پزشک درباره مدرک «${r.title}» نظر داد؛ در بخش «مدارک پزشکی» ببینید.` });
    return { body: view(db.get('SELECT * FROM medical_records WHERE id = ?', r.id), 'doctor') };
  });
}

// OpenAI-compatible vision endpoint (self-hosted, e.g. vLLM serving a VLM). Output is a draft
// for the physician and still passes the output guardrail's dose filter.
async function describeImages(config, images, record) {
  try {
    const content = [
      { type: 'text', text: `تصاویر پیوست مدرک پزشکی بیمار با عنوان «${record.title}» (${RECORD_CATEGORIES[record.category]}) است. برای پزشک معالج به فارسی و فهرست‌وار بنویس: چه نوع مدرکی است، مقادیر یا یافته‌های قابل‌خواندن، و مواردی که ظاهراً خارج از محدوده یا نیازمند توجه‌اند. تشخیص قطعی و توصیه دارویی نده؛ هرجا مطمئن نیستی بنویس «نامشخص».` },
      ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data.toString('base64')}` } })),
    ];
    const res = await fetch(`${config.visionLlmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}) },
      body: JSON.stringify({ model: config.visionLlmModel, temperature: 0.1, max_tokens: 700, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const text = (await res.json()).choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return checkOutput(text).ok ? text : `${text}\n(توجه: متن شامل عبارت دارویی یا تشخیصی بود؛ با احتیاط بخوانید.)`;
  } catch (e) {
    console.warn('[vision] failed:', e.message);
    return null;
  }
}
