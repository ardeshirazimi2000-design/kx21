// Appointment service: doctor calendar (slots), booking with mandatory Idempotency-Key and a
// DB-level slot lock (partial unique index), cancel/reschedule, Kafka-style events.
// The Notification service is a module of Appointment in the MVP (design doc §3).
import { ApiError, badRequest, forbidden, notFound, conflict, requireFields, requireUuid,
  encodeCursor, decodeCursor } from '../lib/http.js';
import { uuid, nowIso, isUniqueViolation, parseJson } from '../lib/db.js';
import { canonical, sha256 } from '../lib/crypto.js';
import { formatFaDateTime } from '../lib/fa.js';
import { requireUser } from './auth.js';
import { SPECIALTIES } from './patient.js';

const CHANNELS = ['video', 'audio', 'chat'];
const MAX_SLOTS_PER_REQUEST = 64;

export function createAppointmentDomain({ db, platform, patientDomain }) {
  const slotView = (s) => ({ id: s.id, doctor_id: s.doctor_id, starts_at: s.starts_at, ends_at: s.ends_at });

  // Free future slots, optionally filtered by doctor or specialty. Used by the REST API and
  // by the assistant's check_availability tool.
  function checkAvailability(tenantId, { doctorId, specialty, from, limit = 20 } = {}) {
    const fromIso = from && !isNaN(Date.parse(from)) ? new Date(from).toISOString() : nowIso();
    const where = ['s.tenant_id = ?', 's.starts_at > ?', 'd.deleted_at IS NULL',
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
      doctor: doc && { id: doc.id, full_name: doc.full_name, specialty: doc.specialty, specialty_label: SPECIALTIES[doc.specialty] },
      consultation: consultation ?? null,
    };
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
    if (slot.starts_at <= nowIso()) throw conflict('زمان این نوبت گذشته است', 'slot_in_past');
    if (triageResultId) {
      const t = db.get('SELECT user_id, patient_id FROM triage_results WHERE id = ? AND tenant_id = ?', triageResultId, ctx.tenantId);
      const p = db.get('SELECT user_id FROM patients WHERE id = ?', patientId);
      if (!t || t.user_id !== p?.user_id) throw badRequest('triage_result_id نامعتبر است');
      if (!t.patient_id) db.run('UPDATE triage_results SET patient_id = ? WHERE id = ?', patientId, triageResultId);
    }

    const id = uuid();
    const ts = nowIso();
    try {
      db.tx(() => {
        db.run(
          `INSERT INTO appointments (id, tenant_id, patient_id, doctor_id, slot_id, status, channel, idempotency_key,
             request_hash, booked_via, triage_result_id, created_at, updated_at)
           VALUES (?,?,?,?,?,'confirmed',?,?,?,?,?,?,?)`,
          id, ctx.tenantId, patientId, doctorId, slotId, channel, scopedKey, requestHash, bookedVia, triageResultId, ts, ts,
        );
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
    platform.audit(ctx, 'appointment.book', `appointment:${id}`, { via: bookedVia, slot_id: slotId });
    platform.publish(ctx, 'appointment.booked', {
      appointment_id: id, patient_id: patientId, doctor_id: doctorId, slot_id: slotId, starts_at: slot.starts_at, booked_via: bookedVia,
    });
    return { appointment: appt, replayed: false };
  }

  function cancel(ctx, appt, reason = null) {
    if (!['pending', 'confirmed'].includes(appt.status)) throw conflict('این نوبت قابل لغو نیست', 'invalid_status');
    db.run(`UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?`, nowIso(), appt.id);
    platform.audit(ctx, 'appointment.cancel', `appointment:${appt.id}`, { reason });
    const slot = db.get('SELECT starts_at FROM slots WHERE id = ?', appt.slot_id);
    platform.publish(ctx, 'appointment.cancelled', {
      appointment_id: appt.id, patient_id: appt.patient_id, doctor_id: appt.doctor_id, starts_at: slot?.starts_at,
      cancelled_by: ctx.user?.role ?? 'system',
    });
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
    if (p) platform.notify(ctx, { userId: p.id, channel: 'sms', target: p.phone, body: `نوبت ${when} لغو شد.` });
    if (d) platform.notify(ctx, { userId: d.id, channel: 'push', target: d.phone, body: `نوبت ${when} (${p?.full_name ?? 'بیمار'}) لغو شد.` });
  });

  return { checkAvailability, book, cancel, appointmentView };
}

export function register(router, { db, platform, domain }) {
  const { checkAvailability, book, cancel, appointmentView } = domain.appointment;

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
    return { body: { items: rows.map((s) => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, booked: !!s.appointment_id })) } };
  });

  router.post('/v1/doctors/me/slots', async (ctx) => {
    requireUser(ctx, 'doctor');
    requireFields(ctx.body, ['starts_at', 'ends_at']);
    const start = Date.parse(ctx.body.starts_at);
    const end = Date.parse(ctx.body.ends_at);
    const dur = Number(ctx.body.duration_min ?? 30);
    if (isNaN(start) || isNaN(end) || end <= start) throw badRequest('بازه زمانی نامعتبر است');
    if (!Number.isInteger(dur) || dur < 10 || dur > 120) throw badRequest('مدت هر نوبت باید بین ۱۰ تا ۱۲۰ دقیقه باشد');
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
