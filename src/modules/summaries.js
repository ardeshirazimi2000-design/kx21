// Visit summaries: when a visit ends a SOAP draft is built from recorded data (triage, profile,
// documents/labs, visit chat, prescriptions). The physician edits it — the assessment is theirs
// alone — and finalizes it; only then does the patient get the plain-language version.
// Fields the physician edited are never overwritten by a later regeneration.
import { badRequest, notFound, conflict, forbidden, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { formatFaDateTime } from '../lib/fa.js';
import { requireUser } from './auth.js';
import { RECORD_CATEGORIES } from './records.js';
import { SPECIALTIES } from './patient.js';
import { buildVisitSummary, buildPatientSummary, ageFrom, SUMMARY_VERSION } from './ai/visit-summary.js';
import { checkOutput } from './ai/guardrails.js';
import { createLlm } from './ai/llm.js';

const EDITABLE = ['subjective', 'objective', 'assessment', 'plan', 'advice', 'follow_up', 'patient_summary'];
const AUTO = ['subjective', 'objective', 'plan', 'advice'];
const MAX_LEN = 8000;

const LLM_SYSTEM = `تو منشی پزشکی هستی. از «داده‌های ثبت‌شده» یک بند کوتاه و روان فارسی برای بخش «شرح حال» (Subjective) پرونده بنویس.
قواعد: فقط واقعیت‌های موجود در داده را بنویس؛ چیزی اضافه نکن؛ هیچ تشخیص، احتمال بیماری یا توصیه درمانی ننویس؛ اعداد و نام داروها را تغییر نده؛ حداکثر ۸ جمله.`;

export function register(router, { db, platform, config, domain }) {
  const llm = createLlm(config);

  const load = (ctx, id) => {
    const c = db.get(
      `SELECT c.*, a.patient_id, a.doctor_id, a.triage_result_id, a.slot_id, a.status AS appointment_status
       FROM consultations c JOIN appointments a ON a.id = c.appointment_id WHERE c.id = ? AND c.tenant_id = ?`,
      requireUuid(id, 'id'), ctx.tenantId,
    );
    if (!c) throw notFound('ویزیت');
    const u = ctx.user;
    if (!(u.role === 'doctor' && c.doctor_id === u.did) && !(u.role === 'patient' && c.patient_id === u.pid)) throw notFound('ویزیت');
    return c;
  };
  const rowOf = (cid) => db.get('SELECT * FROM visit_summaries WHERE consultation_id = ?', cid);

  function facts(c) {
    const p = db.get('SELECT * FROM patients WHERE id = ?', c.patient_id);
    const slot = db.get('SELECT starts_at FROM slots WHERE id = ?', c.slot_id);
    const doc = db.get('SELECT d.specialty, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?', c.doctor_id);
    // The triage linked to the booking, else the patient's latest one in the week before the visit.
    const startsAt = slot?.starts_at ?? c.started_at ?? nowIso();
    const t = (c.triage_result_id && db.get('SELECT * FROM triage_results WHERE id = ?', c.triage_result_id))
      || db.get(`SELECT * FROM triage_results WHERE patient_id = ? AND created_at <= ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
        c.patient_id, startsAt, new Date(Date.parse(startsAt) - 7 * 864e5).toISOString());
    const records = db.all('SELECT * FROM medical_records WHERE appointment_id = ? AND deleted_at IS NULL ORDER BY created_at', c.appointment_id);
    return {
      visit: {
        channel: c.channel, starts_at: startsAt, doctor_name: doc?.full_name, specialty_label: SPECIALTIES[doc?.specialty],
        date_fa: formatFaDateTime(startsAt),
      },
      patient: {
        age: ageFrom(p?.dob), gender: p?.gender, allergies: parseJson(p?.allergies, []), chronic_conditions: parseJson(p?.chronic_conditions, []),
      },
      triage: t ? { ...t, symptoms: parseJson(t.symptoms, []), red_flags: parseJson(t.red_flags, []) } : null,
      messages: db.all(`SELECT sender_role, content, created_at FROM messages WHERE thread_id = ? AND thread_kind = 'consultation' ORDER BY created_at`, c.id),
      records: records.map((r) => ({
        id: r.id, title: r.title, note: r.note, category_label: RECORD_CATEGORIES[r.category], lab_rows: parseJson(r.lab_rows, []),
        file_count: parseJson(r.file_ids, []).length, doctor_opinion: r.doctor_opinion,
      })),
      prescriptions: db.all('SELECT * FROM prescriptions WHERE consultation_id = ? ORDER BY created_at', c.id)
        .map((r) => ({ id: r.id, drugs: parseJson(r.drugs, []), notes: r.notes, status: r.issued_at ? 'issued' : 'draft' })),
    };
  }

  const patientText = (row, f) => buildPatientSummary({
    visit: f.visit, complaint: row.complaint ?? '', prescriptions: f.prescriptions, advice: row.advice ?? '',
    followUp: row.follow_up ?? '', assessmentForPatient: row.share_assessment ? row.assessment ?? '' : '',
  });

  // Build (or refresh) the draft. Physician-edited fields are kept.
  async function generate(ctx, c, { reset = false } = {}) {
    let row = rowOf(c.id);
    if (row?.status === 'final') return row;
    const f = facts(c);
    const d = buildVisitSummary(f);
    let generator = SUMMARY_VERSION;
    const edited = new Set(reset ? [] : parseJson(row?.edited_fields, [])); // assessment/follow-up are never auto-filled anyway
    if (llm.enabled && !edited.has('subjective')) {
      const out = await llm.complete({ system: LLM_SYSTEM, user: `داده‌های ثبت‌شده:\n${d.subjective}` });
      // A rephrasing that slips into diagnosis/dosing language is discarded.
      if (out?.text && checkOutput(out.text).ok) { d.subjective = `${out.text}\n\n— داده‌های مبنا —\n${d.subjective}`; generator = `${SUMMARY_VERSION}+${out.model_version}`; }
    }
    const now = nowIso();
    if (!row) {
      const id = uuid();
      db.run(
        `INSERT INTO visit_summaries (id, tenant_id, consultation_id, appointment_id, patient_id, doctor_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (consultation_id) DO NOTHING`,
        id, ctx.tenantId, c.id, c.appointment_id, c.patient_id, c.doctor_id, now, now,
      );
      row = rowOf(c.id);
    }
    const next = { ...row, complaint: d.complaint };
    for (const k of AUTO) if (!edited.has(k)) next[k] = d[k];
    if (!edited.has('patient_summary')) next.patient_summary = patientText(next, f);
    db.run(
      `UPDATE visit_summaries SET complaint = ?, subjective = ?, objective = ?, plan = ?, advice = ?, patient_summary = ?,
         edited_fields = ?, generator = ?, sources = ?, generated_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      next.complaint, next.subjective, next.objective, next.plan, next.advice, next.patient_summary,
      JSON.stringify([...edited]), generator, JSON.stringify(d.sources), now, now, row.id,
    );
    platform.audit(ctx, 'summary.generate', `consultation:${c.id}`, { generator, reset });
    return rowOf(c.id);
  }

  const doctorView = (r) => r && ({
    id: r.id, consultation_id: r.consultation_id, appointment_id: r.appointment_id, status: r.status,
    subjective: r.subjective ?? '', objective: r.objective ?? '', assessment: r.assessment ?? '', plan: r.plan ?? '',
    advice: r.advice ?? '', follow_up: r.follow_up ?? '', patient_summary: r.patient_summary ?? '',
    share_assessment: !!r.share_assessment, edited_fields: parseJson(r.edited_fields, []),
    generator: r.generator, sources: parseJson(r.sources, []), generated_at: r.generated_at, finalized_at: r.finalized_at, updated_at: r.updated_at,
  });
  const patientView = (r) => {
    const d = db.get('SELECT u.full_name, d.specialty FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?', r.doctor_id);
    return {
      id: r.id, consultation_id: r.consultation_id, appointment_id: r.appointment_id, doctor_name: d?.full_name,
      specialty_label: SPECIALTIES[d?.specialty], patient_summary: r.patient_summary, finalized_at: r.finalized_at,
    };
  };

  // Draft as soon as the visit ends.
  platform.subscribe('consultation.ended', async (e, ctx) => {
    const c = db.get(
      `SELECT c.*, a.patient_id, a.doctor_id, a.triage_result_id, a.slot_id FROM consultations c JOIN appointments a ON a.id = c.appointment_id WHERE c.id = ?`,
      e.consultation_id,
    );
    if (c) await generate({ ...ctx, tenantId: e.tenant_id }, c);
  });

  router.get('/v1/consultations/:id/summary', async (ctx) => {
    requireUser(ctx, 'doctor', 'patient');
    const c = load(ctx, ctx.params.id);
    let row = rowOf(c.id);
    if (ctx.user.role === 'patient') {
      if (row?.status !== 'final') throw notFound('خلاصه ویزیت');
      return { body: patientView(row) };
    }
    if (!row && c.ended_at) row = await generate(ctx, c);
    if (!row) return { body: { status: 'none', consultation_id: c.id } };
    return { body: doctorView(row) };
  });

  // Physician edits (allowed during the visit too — e.g. writing the assessment as notes).
  router.put('/v1/consultations/:id/summary', async (ctx) => {
    requireUser(ctx, 'doctor');
    const c = load(ctx, ctx.params.id);
    let row = rowOf(c.id);
    if (row?.status === 'final') throw conflict('خلاصه نهایی شده و قابل ویرایش نیست', 'summary_final');
    if (!row) {
      const now = nowIso();
      db.run(
        `INSERT INTO visit_summaries (id, tenant_id, consultation_id, appointment_id, patient_id, doctor_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (consultation_id) DO NOTHING`,
        uuid(), ctx.tenantId, c.id, c.appointment_id, c.patient_id, c.doctor_id, now, now,
      );
      row = rowOf(c.id);
    }
    const b = ctx.body ?? {};
    const next = { ...row };
    const edited = new Set(parseJson(row.edited_fields, []));
    for (const k of EDITABLE) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== 'string' || b[k].length > MAX_LEN) throw badRequest(`متن «${k}» نامعتبر یا بیش از حد طولانی است`);
      if (b[k] !== (row[k] ?? '')) { next[k] = b[k].trim(); edited.add(k); }
    }
    if (b.share_assessment !== undefined) next.share_assessment = b.share_assessment ? 1 : 0;
    if (!edited.has('patient_summary')) next.patient_summary = patientText(next, facts(c));
    db.run(
      `UPDATE visit_summaries SET subjective = ?, objective = ?, assessment = ?, plan = ?, advice = ?, follow_up = ?, patient_summary = ?,
         share_assessment = ?, edited_fields = ?, updated_at = ? WHERE id = ?`,
      next.subjective, next.objective, next.assessment, next.plan, next.advice, next.follow_up, next.patient_summary,
      next.share_assessment, JSON.stringify([...edited]), nowIso(), row.id,
    );
    platform.audit(ctx, 'summary.edit', `consultation:${c.id}`, { fields: EDITABLE.filter((k) => b[k] !== undefined) });
    return { body: doctorView(rowOf(c.id)) };
  });

  router.post('/v1/consultations/:id/summary/regenerate', async (ctx) => {
    requireUser(ctx, 'doctor');
    const c = load(ctx, ctx.params.id);
    if (rowOf(c.id)?.status === 'final') throw conflict('خلاصه نهایی شده است', 'summary_final');
    return { body: doctorView(await generate(ctx, c, { reset: !!ctx.body?.reset })) };
  });

  router.post('/v1/consultations/:id/summary/finalize', async (ctx) => {
    requireUser(ctx, 'doctor');
    const c = load(ctx, ctx.params.id);
    if (!c.ended_at) throw conflict('ابتدا ویزیت را پایان دهید', 'consultation_active');
    let row = rowOf(c.id) ?? await generate(ctx, c);
    if (row.status === 'final') return { body: doctorView(row) };
    if (!String(row.assessment ?? '').trim()) throw badRequest('بخش «ارزیابی پزشک» را بنویسید؛ این بخش خودکار پر نمی‌شود', 'assessment_required');
    const f = facts(c);
    if (f.prescriptions.some((r) => r.status === 'draft') && !ctx.body?.allow_unsigned) {
      throw conflict('نسخه پیش‌نویس امضانشده وجود دارد؛ آن را امضا کنید یا تأیید کنید که بدون آن ثبت شود', 'unsigned_prescription');
    }
    // Patient text is refreshed with the final state (e.g. a prescription signed after the draft).
    const patientSummary = parseJson(row.edited_fields, []).includes('patient_summary') ? row.patient_summary : patientText(row, f);
    if (!String(patientSummary ?? '').trim()) throw badRequest('متن خلاصه برای بیمار خالی است');
    const now = nowIso();
    db.run(`UPDATE visit_summaries SET status = 'final', patient_summary = ?, finalized_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      patientSummary, now, now, row.id);
    platform.audit(ctx, 'summary.finalize', `consultation:${c.id}`);
    const pu = db.get('SELECT u.id, u.phone FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', c.patient_id);
    if (pu) platform.notify(ctx, { userId: pu.id, channel: 'sms', target: pu.phone, body: 'خلاصه ویزیت شما آماده است؛ در اپ، بخش «نوبت‌های من» ببینید.' });
    row = rowOf(c.id);
    return { body: doctorView(row) };
  });

  // Patient: own final summaries. Doctor: final summaries of a patient they are treating.
  router.get('/v1/summaries', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    if (ctx.user.role === 'patient') {
      const rows = db.all(`SELECT * FROM visit_summaries WHERE patient_id = ? AND status = 'final' ORDER BY finalized_at DESC LIMIT 50`, ctx.user.pid ?? '-');
      return { body: { items: rows.map(patientView) } };
    }
    const pid = requireUuid(ctx.query.patient_id, 'patient_id');
    if (!domain.patient.doctorHasRelation(ctx.user.did, pid)) throw forbidden('دسترسی فقط با رابطه فعال پزشک-بیمار ممکن است', 'no_care_relationship');
    platform.audit(ctx, 'summary.read_history', `patient:${pid}`);
    const rows = db.all(`SELECT * FROM visit_summaries WHERE patient_id = ? AND tenant_id = ? AND status = 'final' ORDER BY finalized_at DESC LIMIT 20`, pid, ctx.tenantId);
    return { body: { items: rows.map((r) => ({ ...patientView(r), assessment: r.assessment, plan: r.plan, follow_up: r.follow_up, own: r.doctor_id === ctx.user.did })) } };
  });

  domain.summaries = { generate };
}
