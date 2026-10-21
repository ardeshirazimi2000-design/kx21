// Appointment service: doctor calendar (slots), booking with mandatory Idempotency-Key and a
// DB-level slot lock (partial unique index), cancel/reschedule, Kafka-style events.
// The Notification service is a module of Appointment in the MVP (design doc §3).
import { ApiError, badRequest, forbidden, notFound, conflict, requireFields, requireUuid,
  encodeCursor, decodeCursor } from '../lib/http.js';
import { uuid, nowIso, isUniqueViolation, parseJson } from '../lib/db.js';
import { canonical, sha256 } from '../lib/crypto.js';
import { formatFaDateTime, toFaDigits } from '../lib/fa.js';
import { requireUser } from './auth.js';
import { SPECIALTIES } from './patient.js';
import { getVisitSettings, JOIN_LATE_MIN } from '../lib/visit-settings.js';

const CHANNELS = ['video', 'audio', 'chat'];
const MAX_SLOTS_PER_REQUEST = 64;

export function createAppointmentDomain({ db, platform, config = {}, patientDomain, payments = null }) {
  // When the visit room may be entered: from N minutes before the start to 30 minutes after the end.
  function joinWindow(tenantId, slot) {
    if (!slot) return null;
    const early = getVisitSettings(db, tenantId).join_early_min;
    return {
      opens_at: new Date(Date.parse(slot.starts_at) - early * 60000).toISOString(),
      closes_at: new Date(Date.parse(slot.ends_at) + JOIN_LATE_MIN * 60000).toISOString(),
      enforced: !!config.enforceJoinWindow,
    };
  }
  const slotView = (s) => ({ id: s.id, doctor_id: s.doctor_id, starts_at: s.starts_at, ends_at: s.ends_at });

  // Free future slots, optionally filtered by doctor or specialty. Used by the REST API and
  // by the assistant's check_availability tool.
  function checkAvailability(tenantId, { doctorId, specialty, from, limit = 20 } = {}) {
    const fromIso = from && !isNaN(Date.parse(from)) ? new Date(from).toISOString() : nowIso();
    const where = ['s.tenant_id = ?', 's.starts_at > ?', 'd.deleted_at IS NULL', "d.status = 'approved'",
      `NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ('pending','confirmed'))`];
    const params = [tenantId, fromIso];
    if (doctorId) { where.push('s.doctor_id = ?'); params.push(doctorId); }
    if (specialty) { where.push('d.specialty = ?'); params.push(specialty); }
    const rows = db.all(
      `SELECT s.*, d.specialty, u.full_name AS doctor_name FROM slots s
       JOIN doctors d ON d.id = s.doctor_id JOIN users u ON u.id = d.user_id
       WHERE ${where.join(' AND ')} ORDER BY s.starts_at, s.id LIMIT ?`,
      ...params, Math.min(Math.max(Number(limit) || 20, 1), 200),
    );
    return rows.map((s) => ({
      ...slotView(s), doctor_name: s.doctor_name, specialty: s.specialty,
      specialty_label: SPECIALTIES[s.specialty] ?? s.specialty,
    }));
  }

  function appointmentView(a, { forRole } = {}) {
    if (!a) return null;
    const slot = db.get('SELECT * FROM slots WHERE id = ?', a.slot_id);
    const doc = db.get(
      'SELECT d.id, d.specialty, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?', a.doctor_id,
    );
    const consultation = db.get('SELECT id, started_at, ended_at FROM consultations WHERE appointment_id = ?', a.id);
    const out = {
      id: a.id, patient_id: a.patient_id, doctor_id: a.doctor_id, slot_id: a.slot_id,
      status: a.status, channel: a.channel, booked_via: a.booked_via, triage_result_id: a.triage_result_id,
      created_at: a.created_at,
      starts_at: slot?.starts_at, ends_at: slot?.ends_at,
      join: joinWindow(a.tenant_id, slot),
      queue: queueFor(a),
      cancel_reason: a.cancel_reason ?? null, cancelled_by: a.cancelled_by ?? null,
      doctor: doc && { id: doc.id, full_name: doc.full_name, specialty: doc.specialty, specialty_label: SPECIALTIES[doc.specialty] },
      consultation: consultation ?? null,
      payment_due_at: a.payment_due_at ?? null,
      summary_ready: !!(consultation && db.get(`SELECT 1 FROM visit_summaries WHERE consultation_id = ? AND status = 'final'`, consultation.id)),
    };
    if (payments && (!forRole || forRole === 'patient' || forRole === 'admin')) {
      const p = db.get(`SELECT * FROM payments WHERE purpose = 'appointment' AND ref_id = ? ORDER BY created_at DESC LIMIT 1`, a.id);
      out.payment = p ? payments.view(p) : null;
    }
    if (forRole && forRole !== 'patient') {
      const pu = db.get('SELECT u.full_name FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', a.patient_id);
      out.patient = { id: a.patient_id, full_name: pu?.full_name ?? null };
      if (a.triage_result_id) {
        const t = db.get('SELECT id, urgency_level, recommended_specialty, symptoms, red_flags, reviewed_by FROM triage_results WHERE id = ?', a.triage_result_id);
        out.triage = t && { ...t, symptoms: parseJson(t.symptoms, []), red_flags: parseJson(t.red_flags, []) };
      }
    }
    return out;
  }

  // Core booking. Returns { appointment, replayed }.
  function book(ctx, { patientId, doctorId, slotId, channel = 'video', idempotencyKey, bookedVia = 'app', triageResultId = null }) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 64) {
      throw badRequest('هدر Idempotency-Key الزامی است (حداکثر ۶۴ کاراکتر)', 'idempotency_key_required');
    }
    if (!CHANNELS.includes(channel)) throw badRequest('نوع ویزیت نامعتبر است', 'invalid_channel');
    requireUuid(doctorId, 'doctor_id');
    requireUuid(slotId, 'slot_id');
    const scopedKey = `${patientId}:${idempotencyKey}`;
    const requestHash = sha256(canonical({ doctorId, slotId, channel, triageResultId }));

    const prior = db.get('SELECT * FROM appointments WHERE tenant_id = ? AND idempotency_key = ?', ctx.tenantId, scopedKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw badRequest('این Idempotency-Key قبلاً با درخواست دیگری استفاده شده است', 'idempotency_key_reused');
      }
      return { appointment: prior, replayed: true };
    }

    if (!patientDomain.activeConsent(patientId, 'telehealth')) {
      throw forbidden('برای رزرو ویزیت از راه دور، ابتدا رضایت‌نامه ویزیت از راه دور را بپذیرید', 'consent_required');
    }
    const slot = db.get('SELECT * FROM slots WHERE id = ? AND tenant_id = ?', slotId, ctx.tenantId);
    if (!slot || slot.doctor_id !== doctorId) throw notFound('زمان انتخاب‌شده');
    if (db.get('SELECT status FROM doctors WHERE id = ?', doctorId)?.status !== 'approved') throw conflict('این پزشک فعلاً نوبت نمی‌پذیرد', 'doctor_not_available');
    if (slot.starts_at <= nowIso()) throw conflict('زمان این نوبت گذشته است', 'slot_in_past');
    if (triageResultId) {
      const t = db.get('SELECT user_id, patient_id FROM triage_results WHERE id = ? AND tenant_id = ?', triageResultId, ctx.tenantId);
      const p = db.get('SELECT user_id FROM patients WHERE id = ?', patientId);
      if (!t || t.user_id !== p?.user_id) throw badRequest('triage_result_id نامعتبر است');
      if (!t.patient_id) db.run('UPDATE triage_results SET patient_id = ? WHERE id = ?', patientId, triageResultId);
    }

    const id = uuid();
    const ts = nowIso();
    let billing = { status: 'confirmed', payment: null, due_at: null };
    try {
      db.tx(() => {
        const patientUser = db.get('SELECT user_id FROM patients WHERE id = ?', patientId)?.user_id;
        const doctorName = db.get('SELECT u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?', doctorId)?.full_name;
        db.run(
          `INSERT INTO appointments (id, tenant_id, patient_id, doctor_id, slot_id, status, channel, idempotency_key,
             request_hash, booked_via, triage_result_id, created_at, updated_at)
           VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
          id, ctx.tenantId, patientId, doctorId, slotId, channel, scopedKey, requestHash, bookedVia, triageResultId, ts, ts,
        );
        // A visit with a tariff stays "pending" (slot held) until the payment is verified.
        if (payments) billing = payments.forAppointment(ctx, { appointmentId: id, patientUserId: patientUser, channel, doctorName });
        db.run('UPDATE appointments SET status = ?, payment_due_at = ? WHERE id = ?', billing.status, billing.due_at ?? null, id);
        db.run(
          'INSERT INTO consultations (id, tenant_id, appointment_id, room_id, channel) VALUES (?,?,?,?,?)',
          uuid(), ctx.tenantId, id, `room_${uuid().replace(/-/g, '').slice(0, 16)}`, channel,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Lost a race on the same idempotency key → treat as replay.
        const raced = db.get('SELECT * FROM appointments WHERE tenant_id = ? AND idempotency_key = ?', ctx.tenantId, scopedKey);
        if (raced) return { appointment: raced, replayed: true };
        throw conflict('این زمان قبلاً رزرو شده است', 'slot_taken');
      }
      throw e;
    }
    const appt = db.get('SELECT * FROM appointments WHERE id = ?', id);
    platform.audit(ctx, 'appointment.book', `appointment:${id}`, { via: bookedVia, slot_id: slotId, awaiting_payment: !!billing.payment });
    if (billing.status === 'confirmed') {
      platform.publish(ctx, 'appointment.booked', {
        appointment_id: id, patient_id: patientId, doctor_id: doctorId, slot_id: slotId, starts_at: slot.starts_at, booked_via: bookedVia,
      });
    }
    return { appointment: appt, replayed: false, payment: billing.payment };
  }

  function cancel(ctx, appt, reason = null) {
    if (!['pending', 'confirmed'].includes(appt.status)) throw conflict('این نوبت قابل لغو نیست', 'invalid_status');
    const by = ctx.user?.role ?? 'system';
    reason = reason == null ? null : String(reason).trim().slice(0, 300) || null;
    // A doctor cancelling a patient's visit must say why; the patient is told.
    if (by === 'doctor' && reason !== 'rescheduled' && (!reason || reason.length < 3)) {
      throw badRequest('دلیل لغو نوبت را بنویسید؛ برای بیمار ارسال می‌شود', 'cancel_reason_required');
    }
    db.run(`UPDATE appointments SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ?`, reason, by, nowIso(), appt.id);
    platform.audit(ctx, 'appointment.cancel', `appointment:${appt.id}`, { reason, by });
    // Paid visit: the money has to go back (refunds are made by the clinic; admins are told).
    const paid = db.get(`SELECT id, ref_number FROM payments WHERE purpose = 'appointment' AND ref_id = ? AND status = 'paid'`, appt.id);
    if (paid) {
      db.run(`UPDATE payments SET status = 'refund_required' WHERE id = ?`, paid.id);
      for (const ad of db.all(`SELECT id, phone FROM users WHERE tenant_id = ? AND role = 'admin' AND deleted_at IS NULL`, appt.tenant_id)) {
        platform.notify(ctx, { userId: ad.id, channel: 'push', target: ad.phone, body: `نوبت پرداخت‌شده لغو شد (پرداخت ${paid.ref_number ?? ''})؛ بازگشت وجه به بیمار لازم است.` });
      }
    }
    const slot = db.get('SELECT starts_at FROM slots WHERE id = ?', appt.slot_id);
    platform.publish(ctx, 'appointment.cancelled', {
      appointment_id: appt.id, patient_id: appt.patient_id, doctor_id: appt.doctor_id, starts_at: slot?.starts_at,
      cancelled_by: by, reason, refund: !!paid,
    });
  }

  // ---------------------------------------------------------------- live queue
  // A doctor's visits of one (Tehran) day in time order, with what is happening now and when each
  // waiting visit is expected to start: a visit runs from when the doctor enters its room; a visit
  // whose room window passed without the doctor is skipped; waiting visits follow one another.
  const TEHRAN_MS = 210 * 60000; // Iran has no daylight saving time
  const tehranDay = (iso) => {
    const d = Math.floor((Date.parse(iso) + TEHRAN_MS) / 864e5) * 864e5 - TEHRAN_MS;
    return [new Date(d).toISOString(), new Date(d + 864e5).toISOString()];
  };
  function dayQueue(doctorId, anyIsoInDay, now = Date.now()) {
    const [from, to] = tehranDay(anyIsoInDay);
    const rows = db.all(
      `SELECT a.id, a.status, a.patient_id, s.starts_at, s.ends_at, c.id AS consultation_id, c.doctor_joined_at, c.ended_at
       FROM appointments a JOIN slots s ON s.id = a.slot_id LEFT JOIN consultations c ON c.appointment_id = a.id
       WHERE a.doctor_id = ? AND s.starts_at >= ? AND s.starts_at < ? AND a.status IN ('confirmed','completed','no_show')
       ORDER BY s.starts_at, a.id`, doctorId, from, to,
    );
    let free = 0; // when the doctor is expected to be free
    return rows.map((r, i) => {
      const start = Date.parse(r.starts_at);
      const dur = Date.parse(r.ends_at) - start;
      const out = { appointment_id: r.id, consultation_id: r.consultation_id, patient_id: r.patient_id, position: i + 1, total: rows.length, starts_at: r.starts_at };
      if (r.status !== 'confirmed') {
        free = Math.max(free, Date.parse(r.ended_at ?? r.ends_at));
        return { ...out, state: r.status === 'no_show' ? 'no_show' : 'done' };
      }
      if (r.doctor_joined_at && !r.ended_at) {
        const joined = Date.parse(r.doctor_joined_at);
        free = Math.max(joined + dur, now + 60000);
        return { ...out, state: 'in_visit', est_start: r.doctor_joined_at, delay_min: Math.max(0, Math.round((joined - start) / 60000)) };
      }
      const est = Math.max(start, free, now);
      // The room window (with the doctor's running delay) is over and the doctor never came in.
      if (now > Date.parse(r.ends_at) + (30 + Math.max(0, (free - start) / 60000)) * 60000) return { ...out, state: 'missed' };
      free = est + dur;
      return { ...out, state: 'waiting', est_start: new Date(est).toISOString(), delay_min: Math.max(0, Math.round((est - start) / 60000)) };
    });
  }
  // The queue as one patient sees it (only on the visit's day).
  function queueFor(a, now = Date.now()) {
    if (a.status !== 'confirmed') return null;
    const slot = db.get('SELECT starts_at FROM slots WHERE id = ?', a.slot_id);
    if (!slot || tehranDay(slot.starts_at)[0] !== tehranDay(new Date(now).toISOString())[0]) return null;
    const q = dayQueue(a.doctor_id, slot.starts_at, now);
    const me = q.find((x) => x.appointment_id === a.id);
    if (!me) return null;
    const before = q.filter((x) => x.position < me.position);
    return {
      position: me.position, total: me.total, state: me.state, est_start: me.est_start ?? null, delay_min: me.delay_min ?? 0,
      ahead_waiting: before.filter((x) => x.state === 'waiting').length,
      ahead_in_visit: before.filter((x) => x.state === 'in_visit').length,
      done: q.filter((x) => ['done', 'no_show', 'missed'].includes(x.state)).length,
      states: q.map((x) => (x.appointment_id === a.id ? 'me' : x.state)),
    };
  }

  // Reminders before the visit (in-app notification for both sides; SMS too when a sender line is set).
  function remind() {
    const now = Date.now();
    const rows = db.all(
      `SELECT a.*, s.starts_at FROM appointments a JOIN slots s ON s.id = a.slot_id
       WHERE a.status = 'confirmed' AND s.starts_at > ? AND s.starts_at <= ? AND (a.reminded_60_at IS NULL OR a.reminded_room_at IS NULL)`,
      new Date(now - 5 * 60000).toISOString(), new Date(now + 61 * 60000).toISOString(),
    );
    for (const a of rows) {
      const ctx = { tenantId: a.tenant_id, user: null };
      const p = userOfPatient(a.patient_id);
      const d = userOfDoctor(a.doctor_id);
      const left = Math.round((Date.parse(a.starts_at) - now) / 60000);
      const when = formatFaDateTime(a.starts_at);
      const early = getVisitSettings(db, a.tenant_id).join_early_min;
      if (!a.reminded_room_at && left <= Math.max(early, 1)) {
        db.run('UPDATE appointments SET reminded_room_at = ?, reminded_60_at = COALESCE(reminded_60_at, ?) WHERE id = ?', nowIso(), nowIso(), a.id);
        if (p) platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `اتاق ویزیت شما با ${d?.full_name ?? 'پزشک'} باز شد (${when}). از «نوبت‌ها» وارد شوید.` });
        if (d) platform.notify(ctx, { userId: d.id, channel: 'push', target: d.phone, body: `اتاق ویزیت با ${p?.full_name ?? 'بیمار'} باز شد (${when}).` });
      } else if (!a.reminded_60_at && left > Math.max(early, 1)) {
        db.run('UPDATE appointments SET reminded_60_at = ? WHERE id = ?', nowIso(), a.id);
        if (p) platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `یادآوری: ویزیت شما با ${d?.full_name ?? 'پزشک'} حدود ${toFaDigits(left)} دقیقه دیگر (${when}).` });
        if (d) platform.notify(ctx, { userId: d.id, channel: 'push', target: d.phone, body: `یادآوری: ویزیت ${p?.full_name ?? 'بیمار'} حدود ${toFaDigits(left)} دقیقه دیگر (${when}).` });
      }
    }
  }
  // Queue notifications for today's waiting visits: "you are next" and "the doctor is running late".
  function queueNotify(now = Date.now()) {
    const [from, to] = tehranDay(new Date(now).toISOString());
    const rows = db.all(
      `SELECT a.* FROM appointments a JOIN slots s ON s.id = a.slot_id
       WHERE a.status = 'confirmed' AND s.starts_at >= ? AND s.starts_at < ?`, from, to,
    );
    for (const a of rows) {
      const q = queueFor(a, now);
      if (!q || q.state !== 'waiting') continue;
      const p = userOfPatient(a.patient_id);
      const d = userOfDoctor(a.doctor_id);
      if (!p) continue;
      const ctx = { tenantId: a.tenant_id, user: null };
      const at = formatFaDateTime(q.est_start).split(' ').slice(-1)[0];
      const left = Math.round((Date.parse(q.est_start) - now) / 60000);
      if (!a.queue_next_at && q.ahead_waiting === 0 && left <= 15) {
        db.run('UPDATE appointments SET queue_next_at = ? WHERE id = ?', nowIso(), a.id);
        platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `نوبت شما بعدی است${q.ahead_in_visit ? ' (یک ویزیت در حال انجام است)' : ''}؛ زمان تخمینی شروع ویزیت با ${d?.full_name ?? 'پزشک'}: ${at}. در اپ آماده باشید.` });
      }
      if (q.delay_min >= 15 && q.delay_min >= (a.queue_delay_notified ?? 0) + 15) {
        db.run('UPDATE appointments SET queue_delay_notified = ? WHERE id = ?', q.delay_min, a.id);
        platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `ویزیت‌های ${d?.full_name ?? 'پزشک'} حدود ${toFaDigits(q.delay_min)} دقیقه تأخیر دارد؛ زمان تخمینی شروع ویزیت شما: ${at}.` });
      }
    }
  }
  if (!config.disableSweeper) {
    setInterval(() => {
      try { remind(); } catch (e) { console.error('[reminders]', e.message); }
      try { queueNotify(); } catch (e) { console.error('[queue]', e.message); }
    }, 60_000).unref();
  }

  // Notification module: subscribes to appointment events.
  const userOfPatient = (pid) => db.get('SELECT u.id, u.phone, u.full_name FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', pid);
  const userOfDoctor = (did) => db.get('SELECT u.id, u.phone, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?', did);

  platform.subscribe('appointment.booked', (e, ctx) => {
    const p = userOfPatient(e.patient_id);
    const d = userOfDoctor(e.doctor_id);
    const when = formatFaDateTime(e.starts_at);
    if (p) platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `نوبت شما با ${d?.full_name} برای ${when} ثبت شد.` });
    if (d) platform.notify(ctx, { userId: d.id, channel: 'push', target: d.phone, body: `نوبت جدید: ${p?.full_name ?? 'بیمار'} — ${when}` });
  });
  platform.subscribe('appointment.cancelled', (e, ctx) => {
    const p = userOfPatient(e.patient_id);
    const d = userOfDoctor(e.doctor_id);
    const when = e.starts_at ? formatFaDateTime(e.starts_at) : '';
    if (e.reason === 'rescheduled') return;
    const why = e.reason ? ` دلیل: ${e.reason}` : '';
    const refund = e.refund ? ' هزینه پرداختی شما بازگردانده می‌شود.' : '';
    if (p) platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: e.cancelled_by === 'doctor' ? `نوبت ${when} با ${d?.full_name ?? 'پزشک'} توسط پزشک لغو شد.${why}${refund}` : `نوبت ${when} لغو شد.${refund}` });
    if (d) platform.notify(ctx, { userId: d.id, channel: 'push', target: d.phone, body: `نوبت ${when} (${p?.full_name ?? 'بیمار'}) لغو شد${e.cancelled_by === 'patient' ? ' (توسط بیمار)' : ''}.` });
  });

  return { checkAvailability, book, cancel, appointmentView, remind, joinWindow, dayQueue, queueFor, queueNotify, tehranDay };
}

export function register(router, { db, platform, domain }) {
  const { checkAvailability, book, cancel, appointmentView, dayQueue } = domain.appointment;

  const loadForActor = (ctx, id) => {
    requireUuid(id, 'id');
    const a = db.get('SELECT * FROM appointments WHERE id = ? AND tenant_id = ?', id, ctx.tenantId);
    if (!a) throw notFound('نوبت');
    const u = ctx.user;
    const allowed = (u.role === 'patient' && a.patient_id === u.pid) || (u.role === 'doctor' && a.doctor_id === u.did)
      || ['operator', 'admin'].includes(u.role);
    if (!allowed) throw notFound('نوبت'); // do not leak existence
    return a;
  };

  router.get('/v1/doctors/:id/slots', async (ctx) => {
    requireUser(ctx);
    const doctorId = requireUuid(ctx.params.id, 'id');
    return { body: { items: checkAvailability(ctx.tenantId, { doctorId, from: ctx.query.from, limit: ctx.query.limit ?? 50 }) } };
  });

  router.get('/v1/slots', async (ctx) => {
    requireUser(ctx);
    return { body: { items: checkAvailability(ctx.tenantId, { specialty: ctx.query.specialty, from: ctx.query.from, limit: ctx.query.limit ?? 50 }) } };
  });

  // Doctor calendar
  router.get('/v1/doctors/me/slots', async (ctx) => {
    requireUser(ctx, 'doctor');
    const rows = db.all(
      `SELECT s.*, (SELECT a.id FROM appointments a WHERE a.slot_id = s.id AND a.status IN ('pending','confirmed')) AS appointment_id
       FROM slots s WHERE s.doctor_id = ? AND s.ends_at > ? ORDER BY s.starts_at LIMIT 300`,
      ctx.user.did, nowIso(),
    );
    return { body: { items: rows.map((s) => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, booked: !!s.appointment_id, appointment_id: s.appointment_id ?? null })), visit: getVisitSettings(db, ctx.tenantId) } };
  });

  const requireApprovedDoctor = (ctx) => {
    requireUser(ctx, 'doctor');
    const st = db.get('SELECT status FROM doctors WHERE id = ?', ctx.user.did)?.status;
    if (st !== 'approved') throw forbidden('انتشار نوبت پس از تأیید مدارک توسط مدیر ممکن است', 'doctor_not_approved');
  };

  router.post('/v1/doctors/me/slots', async (ctx) => {
    requireApprovedDoctor(ctx);
    requireFields(ctx.body, ['starts_at', 'ends_at']);
    const start = Date.parse(ctx.body.starts_at);
    const end = Date.parse(ctx.body.ends_at);
    const visit = getVisitSettings(db, ctx.tenantId);
    const dur = Number(ctx.body.duration_min ?? visit.default);
    if (isNaN(start) || isNaN(end) || end <= start) throw badRequest('بازه زمانی نامعتبر است');
    if (!visit.durations.includes(dur)) throw badRequest(`مدت هر نوبت باید یکی از این مقادیر باشد: ${visit.durations.join('، ')} دقیقه`, 'duration_not_allowed');
    if (start < Date.now()) throw badRequest('بازه باید در آینده باشد');
    const count = Math.floor((end - start) / (dur * 60000));
    if (count < 1) throw badRequest('بازه از مدت یک نوبت کوتاه‌تر است');
    if (count > MAX_SLOTS_PER_REQUEST) throw badRequest(`حداکثر ${MAX_SLOTS_PER_REQUEST} نوبت در هر درخواست`);
    const created = [];
    db.tx(() => {
      for (let i = 0; i < count; i++) {
        const s = new Date(start + i * dur * 60000).toISOString();
        const e = new Date(start + (i + 1) * dur * 60000).toISOString();
        const overlap = db.get('SELECT 1 FROM slots WHERE doctor_id = ? AND starts_at < ? AND ends_at > ?', ctx.user.did, e, s);
        if (overlap) continue;
        const id = uuid();
        db.run('INSERT INTO slots (id, tenant_id, doctor_id, starts_at, ends_at) VALUES (?,?,?,?,?)', id, ctx.tenantId, ctx.user.did, s, e);
        created.push({ id, starts_at: s, ends_at: e });
      }
    });
    if (created.length) {
      platform.audit(ctx, 'slot.publish', `doctor:${ctx.user.did}`, { count: created.length });
      platform.publish(ctx, 'slot.published', { doctor_id: ctx.user.did, slot_ids: created.map((s) => s.id) });
    }
    return { status: 201, body: { created: created.length, skipped_overlapping: count - created.length, items: created } };
  });

  router.delete('/v1/doctors/me/slots/:id', async (ctx) => {
    requireUser(ctx, 'doctor');
    const s = db.get('SELECT * FROM slots WHERE id = ? AND doctor_id = ?', requireUuid(ctx.params.id, 'id'), ctx.user.did);
    if (!s) throw notFound('زمان');
    if (db.get('SELECT 1 FROM appointments WHERE slot_id = ?', s.id)) throw conflict('این زمان نوبت ثبت‌شده دارد', 'slot_has_appointment');
    db.run('DELETE FROM slots WHERE id = ?', s.id);
    return { status: 204 };
  });

  // Appointments
  router.post('/v1/appointments', async (ctx) => {
    requireUser(ctx, 'patient');
    if (!ctx.user.pid) throw new ApiError(404, 'profile_incomplete', 'ابتدا پروفایل خود را تکمیل کنید');
    requireFields(ctx.body, ['doctor_id', 'slot_id', 'channel']);
    const { appointment, replayed } = book(ctx, {
      patientId: ctx.user.pid, doctorId: ctx.body.doctor_id, slotId: ctx.body.slot_id, channel: ctx.body.channel,
      idempotencyKey: ctx.req.headers['idempotency-key'], triageResultId: ctx.body.triage_result_id ?? null,
    });
    return { status: replayed ? 200 : 201, body: appointmentView(appointment), headers: replayed ? { 'Idempotent-Replayed': 'true' } : {} };
  });

  router.get('/v1/appointments', async (ctx) => {
    requireUser(ctx);
    const u = ctx.user;
    const where = ['tenant_id = ?'];
    const params = [ctx.tenantId];
    if (u.role === 'patient') { where.push('patient_id = ?'); params.push(u.pid ?? '-'); }
    else if (u.role === 'doctor') { where.push('doctor_id = ?'); params.push(u.did); }
    if (ctx.query.status) { where.push('status = ?'); params.push(ctx.query.status); }
    const cur = decodeCursor(ctx.query.cursor);
    if (cur) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); params.push(cur.created_at, cur.created_at, cur.id); }
    const limit = Math.min(Number(ctx.query.limit) || 20, 100);
    const rows = db.all(`SELECT * FROM appointments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, limit + 1);
    const page = rows.slice(0, limit);
    return {
      body: {
        items: page.map((a) => appointmentView(a, { forRole: u.role })),
        next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      },
    };
  });

  router.get('/v1/appointments/:id', async (ctx) => {
    requireUser(ctx);
    const a = loadForActor(ctx, ctx.params.id);
    return { body: appointmentView(a, { forRole: ctx.user.role }) };
  });

  router.post('/v1/appointments/:id/cancel', async (ctx) => {
    requireUser(ctx);
    const a = loadForActor(ctx, ctx.params.id);
    cancel(ctx, a, ctx.body.reason ?? null);
    return { body: appointmentView(db.get('SELECT * FROM appointments WHERE id = ?', a.id), { forRole: ctx.user.role }) };
  });

  // The doctor's queue for a day (default today): order, state and expected start of every visit.
  router.get('/v1/doctors/me/queue', async (ctx) => {
    requireUser(ctx, 'doctor');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query.date ?? '')) ? new Date(`${ctx.query.date}T12:00:00+03:30`).toISOString() : new Date().toISOString();
    const items = dayQueue(ctx.user.did, day).map((x) => {
      const pu = db.get('SELECT u.full_name FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', x.patient_id);
      return { ...x, patient_name: pu?.full_name ?? null };
    });
    return { body: { items } };
  });

  // The patient did not come: the doctor closes the visit so the queue moves on.
  router.post('/v1/appointments/:id/no-show', async (ctx) => {
    requireUser(ctx, 'doctor');
    const a = loadForActor(ctx, ctx.params.id);
    if (a.status !== 'confirmed') throw conflict('این نوبت فعال نیست', 'invalid_status');
    const slot = db.get('SELECT starts_at FROM slots WHERE id = ?', a.slot_id);
    if (Date.parse(slot.starts_at) > Date.now()) throw conflict('عدم حضور فقط بعد از شروع زمان نوبت ثبت می‌شود', 'too_early');
    db.run(`UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ?`, nowIso(), a.id);
    db.run('UPDATE consultations SET ended_at = COALESCE(ended_at, ?) WHERE appointment_id = ?', nowIso(), a.id);
    platform.audit(ctx, 'appointment.no_show', `appointment:${a.id}`);
    const p = db.get('SELECT u.id, u.phone FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', a.patient_id);
    if (p) platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `برای نوبت ${formatFaDateTime(slot.starts_at)} عدم حضور ثبت شد. در صورت نیاز نوبت جدید بگیرید.` });
    return { body: appointmentView(db.get('SELECT * FROM appointments WHERE id = ?', a.id), { forRole: 'doctor' }) };
  });

  router.post('/v1/appointments/:id/reschedule', async (ctx) => {
    requireUser(ctx, 'patient');
    const a = loadForActor(ctx, ctx.params.id);
    requireFields(ctx.body, ['slot_id']);
    const key = ctx.req.headers['idempotency-key'];
    const result = db.tx(() => {
      const r = book(ctx, {
        patientId: a.patient_id, doctorId: ctx.body.doctor_id ?? a.doctor_id, slotId: ctx.body.slot_id,
        channel: ctx.body.channel ?? a.channel, idempotencyKey: key, triageResultId: a.triage_result_id,
      });
      if (!r.replayed) cancel(ctx, a, 'rescheduled');
      return r;
    });
    return { status: result.replayed ? 200 : 201, body: appointmentView(result.appointment) };
  });

  // Notification inbox (stand-in for SMS/Push delivery; visible in dev for demo purposes)
  router.get('/v1/notifications', async (ctx) => {
    requireUser(ctx);
    const rows = db.all(
      'SELECT id, channel, body, status, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      ctx.user.sub,
    );
    return { body: { items: rows } };
  });
}
