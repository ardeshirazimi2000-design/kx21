// Consultation service: visit room join (LiveKit-style access token), in-room text chat
// (also the fallback channel when video/audio fails), end of visit. Prescription service
// (v1 in the roadmap) is included: drafts are invalid until the doctor signs them (Ed25519).
import { badRequest, forbidden, notFound, conflict, requireFields, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson, isUniqueViolation } from '../lib/db.js';
import crypto from 'node:crypto';
import { signJwt, signPayload, verifyPayload, canonical, sha256 } from '../lib/crypto.js';
import { requireUser } from './auth.js';

const JOIN_EARLY_MIN = 15;
const JOIN_LATE_MIN = 60;

export function register(router, { db, keys, platform, config, domain }) {
  const loadConsultation = (ctx, id) => {
    requireUuid(id, 'id');
    const c = db.get(
      `SELECT c.*, a.patient_id, a.doctor_id, a.status AS appointment_status, a.slot_id
       FROM consultations c JOIN appointments a ON a.id = c.appointment_id
       WHERE c.id = ? AND c.tenant_id = ?`, id, ctx.tenantId,
    );
    if (!c) throw notFound('ویزیت');
    const u = ctx.user;
    const isPatient = u.role === 'patient' && c.patient_id === u.pid;
    const isDoctor = u.role === 'doctor' && c.doctor_id === u.did;
    if (!isPatient && !isDoctor) throw notFound('ویزیت');
    return { ...c, isDoctor };
  };

  router.post('/v1/consultations/:id/join', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    if (c.appointment_status !== 'confirmed') throw conflict('این نوبت فعال نیست', 'appointment_not_active');
    const slot = db.get('SELECT starts_at, ends_at FROM slots WHERE id = ?', c.slot_id);
    const now = Date.now();
    if (config.enforceJoinWindow) {
      if (now < Date.parse(slot.starts_at) - JOIN_EARLY_MIN * 60000) {
        throw conflict(`ورود به اتاق از ${JOIN_EARLY_MIN} دقیقه قبل از نوبت ممکن است`, 'too_early');
      }
      if (now > Date.parse(slot.ends_at) + JOIN_LATE_MIN * 60000) throw conflict('زمان این ویزیت گذشته است', 'too_late');
    }
    if (!c.started_at) {
      db.run('UPDATE consultations SET started_at = ? WHERE id = ? AND started_at IS NULL', nowIso(), c.id);
      platform.publish(ctx, 'consultation.started', { consultation_id: c.id, appointment_id: c.appointment_id });
    }
    platform.audit(ctx, 'consultation.join', `consultation:${c.id}`);
    // Access token in the LiveKit grant shape; signed locally. Swap the key for the LiveKit API secret in prod.
    const token = signJwt({ jwtKey: keys.livekitKey }, {
      iss: 'telehealth', sub: ctx.user.sub,
      video: { room: c.room_id, roomJoin: true, canPublish: true, canSubscribe: true },
      metadata: JSON.stringify({ role: ctx.user.role }),
    }, 60 * 60);
    return {
      body: {
        consultation_id: c.id, room_id: c.room_id, channel: c.channel, token,
        media_url: config.livekitUrl || null,
        ice_servers: iceServers(ctx.user.sub),
        // Fallback order when bandwidth is poor (design doc §10/§12).
        fallback: ['video', 'audio', 'chat'].slice(['video', 'audio', 'chat'].indexOf(c.channel)),
      },
    };
  });

  // ---------------- 1:1 video/audio call (WebRTC peer-to-peer) ----------------
  // The server only relays signalling (SDP offer/answer, ICE candidates); media flows directly
  // between the two phones, DTLS-SRTP encrypted, or through the clinic's own TURN relay.
  function iceServers(userId) {
    const list = [];
    if (config.turnUrls.length && config.turnSecret) {
      // TURN REST API credentials (coturn use-auth-secret): valid for 12 hours.
      const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${userId}`;
      const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
      list.push({ urls: config.turnUrls, username, credential });
      const stun = config.turnUrls.map((u) => u.replace(/^turns?:/, 'stun:').replace(/\?.*$/, ''));
      list.push({ urls: [...new Set(stun)] });
    }
    if (config.stunUrls.length) list.push({ urls: config.stunUrls });
    return list;
  }

  const SIGNAL_TYPES = ['ready', 'here', 'offer', 'answer', 'ice', 'bye'];
  const signals = new Map(); // consultation id -> { seq, items: [{ seq, from, type, data, at }] }
  const box = (id) => {
    let b = signals.get(id);
    if (!b) signals.set(id, (b = { seq: 0, items: [] }));
    return b;
  };
  setInterval(() => { // drop idle rooms
    const cutoff = Date.now() - 30 * 60000;
    for (const [id, b] of signals) if (!b.items.length || b.items[b.items.length - 1].at < cutoff) signals.delete(id);
  }, 10 * 60000).unref();

  router.post('/v1/consultations/:id/signal', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    if (c.ended_at) throw conflict('این ویزیت پایان یافته است', 'consultation_ended');
    const { type, data = null } = ctx.body;
    if (!SIGNAL_TYPES.includes(type)) throw badRequest('نوع سیگنال نامعتبر است');
    if (JSON.stringify(data ?? null).length > 64 * 1024) throw badRequest('داده سیگنال بیش از حد بزرگ است');
    const b = box(c.id);
    const item = { seq: ++b.seq, from: ctx.user.role, type, data, at: Date.now() };
    b.items.push(item);
    if (b.items.length > 300) b.items.splice(0, b.items.length - 300);
    if (type === 'ready' || type === 'bye') platform.audit(ctx, `consultation.call_${type === 'ready' ? 'join' : 'leave'}`, `consultation:${c.id}`);
    return { status: 201, body: { seq: item.seq } };
  });

  // after=-1 → only the current position (start listening from now).
  router.get('/v1/consultations/:id/signal', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    const b = box(c.id);
    const after = Number(ctx.query.after ?? -1);
    if (after < 0) return { body: { seq: b.seq, items: [] } };
    const items = b.items.filter((i) => i.seq > after && i.from !== ctx.user.role)
      .map(({ seq, type, data }) => ({ seq, type, data }));
    return { body: { seq: b.seq, items, ended: !!c.ended_at } };
  });

  router.get('/v1/consultations/:id', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    return {
      body: {
        id: c.id, appointment_id: c.appointment_id, room_id: c.room_id, channel: c.channel,
        started_at: c.started_at, ended_at: c.ended_at, patient_id: c.patient_id, doctor_id: c.doctor_id,
      },
    };
  });

  router.get('/v1/consultations/:id/messages', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    const after = ctx.query.after || '';
    const rows = db.all(
      `SELECT id, sender_role, content, created_at FROM messages
       WHERE thread_id = ? AND thread_kind = 'consultation' AND created_at > ? ORDER BY created_at LIMIT 200`,
      c.id, after,
    );
    return { body: { items: rows, ended_at: c.ended_at } };
  });

  router.post('/v1/consultations/:id/messages', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    if (c.ended_at) throw conflict('این ویزیت پایان یافته است', 'consultation_ended');
    const text = String(ctx.body.content ?? '').trim();
    if (!text || text.length > 4000) throw badRequest('متن پیام خالی یا بیش از حد طولانی است');
    const id = uuid();
    const ts = nowIso();
    db.run(
      `INSERT INTO messages (id, tenant_id, thread_id, thread_kind, sender_id, sender_role, content, created_at)
       VALUES (?,?,?,'consultation',?,?,?,?)`,
      id, ctx.tenantId, c.id, ctx.user.sub, ctx.user.role, text, ts,
    );
    return { status: 201, body: { id, sender_role: ctx.user.role, content: text, created_at: ts } };
  });

  router.post('/v1/consultations/:id/end', async (ctx) => {
    requireUser(ctx, 'doctor');
    const c = loadConsultation(ctx, ctx.params.id);
    if (c.ended_at) return { body: { id: c.id, ended_at: c.ended_at } };
    const ts = nowIso();
    db.tx(() => {
      db.run('UPDATE consultations SET ended_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?', ts, ts, c.id);
      db.run(`UPDATE appointments SET status = 'completed', updated_at = ? WHERE id = ?`, ts, c.appointment_id);
    });
    platform.audit(ctx, 'consultation.end', `consultation:${c.id}`);
    platform.publish(ctx, 'consultation.ended', {
      consultation_id: c.id, appointment_id: c.appointment_id, patient_id: c.patient_id, doctor_id: c.doctor_id,
    });
    return { body: { id: c.id, ended_at: ts } };
  });

  // ---------------- prescriptions ----------------
  const validateDrugs = (drugs) => {
    if (!Array.isArray(drugs) || drugs.length === 0 || drugs.length > 20) throw badRequest('فهرست داروها خالی یا نامعتبر است');
    return drugs.map((d) => {
      if (!d || typeof d.name !== 'string' || !d.name.trim()) throw badRequest('نام دارو الزامی است');
      const pick = (k) => (d[k] == null ? null : String(d[k]).slice(0, 200));
      return { name: d.name.trim().slice(0, 200), dose: pick('dose'), frequency: pick('frequency'), duration: pick('duration'), instructions: pick('instructions') };
    });
  };

  const rxView = (r) => ({
    id: r.id, consultation_id: r.consultation_id, doctor_id: r.doctor_id, patient_id: r.patient_id,
    drugs: parseJson(r.drugs, []), notes: r.notes, status: r.issued_at ? 'issued' : 'draft',
    issued_at: r.issued_at, created_at: r.created_at,
    signature: r.signature ? Buffer.from(r.signature).toString('base64') : null,
  });

  const signedPayload = (r) => canonical({
    id: r.id, consultation_id: r.consultation_id, doctor_id: r.doctor_id, patient_id: r.patient_id,
    drugs: parseJson(r.drugs, []), notes: r.notes ?? null, issued_at: r.issued_at,
  });

  // Draft creation; also used by the assistant's create_prescription_draft tool (doctor sessions only).
  function createDraft(ctx, { consultationId, drugs, notes, idempotencyKey }) {
    requireUser(ctx, 'doctor');
    if (!idempotencyKey) throw badRequest('هدر Idempotency-Key الزامی است', 'idempotency_key_required');
    const c = loadConsultation(ctx, consultationId);
    if (!c.isDoctor) throw forbidden();
    const items = validateDrugs(drugs);
    const key = `${ctx.user.did}:${idempotencyKey}`;
    const prior = db.get('SELECT * FROM prescriptions WHERE tenant_id = ? AND idempotency_key = ?', ctx.tenantId, key);
    if (prior) return { rx: prior, replayed: true };
    const id = uuid();
    try {
      db.run(
        `INSERT INTO prescriptions (id, tenant_id, consultation_id, doctor_id, patient_id, drugs, notes, idempotency_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id, ctx.tenantId, c.id, c.doctor_id, c.patient_id, JSON.stringify(items), notes ? String(notes).slice(0, 2000) : null, key, nowIso(),
      );
    } catch (e) {
      if (isUniqueViolation(e)) return { rx: db.get('SELECT * FROM prescriptions WHERE idempotency_key = ?', key), replayed: true };
      throw e;
    }
    platform.audit(ctx, 'prescription.draft', `prescription:${id}`);
    return { rx: db.get('SELECT * FROM prescriptions WHERE id = ?', id), replayed: false };
  }
  domain.prescription = { createDraft };

  router.post('/v1/prescriptions', async (ctx) => {
    requireFields(ctx.body, ['consultation_id', 'drugs']);
    const { rx, replayed } = createDraft(ctx, {
      consultationId: ctx.body.consultation_id, drugs: ctx.body.drugs, notes: ctx.body.notes,
      idempotencyKey: ctx.req.headers['idempotency-key'],
    });
    return { status: replayed ? 200 : 201, body: rxView(rx) };
  });

  router.post('/v1/prescriptions/:id/sign', async (ctx) => {
    requireUser(ctx, 'doctor');
    const r = db.get('SELECT * FROM prescriptions WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!r || r.doctor_id !== ctx.user.did) throw notFound('نسخه');
    if (r.issued_at) return { body: rxView(r) };
    const doc = db.get('SELECT sign_private_sealed FROM doctors WHERE id = ?', r.doctor_id);
    const issued = { ...r, issued_at: nowIso() };
    const sig = signPayload(keys, doc.sign_private_sealed, signedPayload(issued));
    db.run('UPDATE prescriptions SET signature = ?, issued_at = ? WHERE id = ? AND issued_at IS NULL', sig, issued.issued_at, r.id);
    platform.audit(ctx, 'prescription.issue', `prescription:${r.id}`, { payload_sha256: sha256(signedPayload(issued)) });
    platform.publish(ctx, 'prescription.issued', { prescription_id: r.id, patient_id: r.patient_id, doctor_id: r.doctor_id });
    const pu = db.get('SELECT u.id, u.phone FROM patients p JOIN users u ON u.id = p.user_id WHERE p.id = ?', r.patient_id);
    if (pu) platform.notify(ctx, { userId: pu.id, channel: 'sms', target: pu.phone, body: 'نسخه الکترونیک شما صادر شد و در اپ قابل مشاهده است.' });
    return { body: rxView(db.get('SELECT * FROM prescriptions WHERE id = ?', r.id)) };
  });

  router.get('/v1/prescriptions', async (ctx) => {
    requireUser(ctx, 'patient', 'doctor');
    const rows = ctx.user.role === 'patient'
      ? db.all('SELECT * FROM prescriptions WHERE patient_id = ? AND issued_at IS NOT NULL ORDER BY issued_at DESC', ctx.user.pid ?? '-')
      : db.all(
        ctx.query.consultation_id
          ? 'SELECT * FROM prescriptions WHERE doctor_id = ? AND consultation_id = ? ORDER BY created_at DESC'
          : 'SELECT * FROM prescriptions WHERE doctor_id = ? ORDER BY created_at DESC LIMIT 100',
        ...(ctx.query.consultation_id ? [ctx.user.did, ctx.query.consultation_id] : [ctx.user.did]),
      );
    return {
      body: {
        items: rows.map((r) => {
          const d = db.get('SELECT u.full_name, d.license_no FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?', r.doctor_id);
          return { ...rxView(r), doctor_name: d?.full_name, doctor_license_no: d?.license_no };
        }),
      },
    };
  });

  // Public verification (pharmacy): checks the doctor's signature over the canonical payload.
  router.get('/v1/prescriptions/:id/verify', async (ctx) => {
    const r = db.get('SELECT * FROM prescriptions WHERE id = ?', requireUuid(ctx.params.id, 'id'));
    if (!r) throw notFound('نسخه');
    if (!r.issued_at) return { body: { valid: false, reason: 'draft' } };
    const doc = db.get('SELECT sign_public_pem FROM doctors WHERE id = ?', r.doctor_id);
    const valid = verifyPayload(doc.sign_public_pem, signedPayload(r), r.signature);
    return { body: { valid, issued_at: r.issued_at, drugs: valid ? parseJson(r.drugs, []) : undefined } };
  });

}
