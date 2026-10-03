// AI Assistant + Triage + escalation (operator console) endpoints.
import { ApiError, badRequest, notFound, forbidden, openSse, requireFields, requireUuid } from '../../lib/http.js';
import { uuid, nowIso, parseJson } from '../../lib/db.js';
import { checkInput } from './guardrails.js';
import { requireUser } from '../auth.js';

export function register(router, { db, platform, limiter, domain }) {
  const assistant = domain.assistant;

  router.post('/v1/ai/chat', async (ctx) => {
    requireUser(ctx, 'patient');
    limiter.hit(`ai:${ctx.user.sub}`, 30, 60_000);
    limiter.hit(`ai-tenant:${ctx.tenantId}`, 3000, 60_000);
    requireFields(ctx.body, ['session_id', 'message']);
    const sessionId = requireUuid(ctx.body.session_id, 'session_id');
    const { type, content } = ctx.body.message ?? {};
    if (type === 'voice') throw new ApiError(422, 'voice_not_supported', 'پیام صوتی در فاز بعد (STT) فعال می‌شود');
    if (type === 'image') throw new ApiError(422, 'image_not_supported', 'ارسال تصویر فقط در اتاق ویزیت با پزشک ممکن است');
    if (type !== 'text') throw badRequest('نوع پیام نامعتبر است');
    const g = checkInput(content);
    if (!g.ok) throw badRequest(g.message, `input_${g.code}`);
    if (g.injection) platform.audit(ctx, 'ai.guardrail.injection_attempt', `ai_session:${sessionId}`);

    const owner = db.get('SELECT user_id FROM chat_sessions WHERE id = ?', sessionId);
    if (owner && owner.user_id !== ctx.user.sub) throw forbidden('این گفتگو متعلق به شما نیست');

    const sse = openSse(ctx.res);
    let closed = false;
    ctx.res.on('close', () => { closed = true; });
    const emit = (event, data) => { if (!closed) sse.send(event, data); };
    await assistant.processMessage(ctx, sessionId, String(content).trim(), emit);
    sse.end();
    return null; // response already written
  });

  router.get('/v1/ai/sessions', async (ctx) => {
    requireUser(ctx, 'patient');
    const rows = db.all('SELECT id, mode, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20', ctx.user.sub);
    return { body: { items: rows } };
  });

  router.get('/v1/ai/sessions/:id/messages', async (ctx) => {
    requireUser(ctx, 'patient');
    const s = db.get('SELECT * FROM chat_sessions WHERE id = ?', requireUuid(ctx.params.id, 'id'));
    if (!s || s.user_id !== ctx.user.sub) throw notFound('گفتگو');
    const rows = db.all(
      `SELECT id, sender_role, content, ai_meta, created_at FROM messages
       WHERE thread_id = ? AND thread_kind = 'ai' AND created_at > ? ORDER BY created_at, rowid LIMIT 300`,
      s.id, ctx.query.after || '',
    );
    return {
      body: {
        mode: s.mode,
        items: rows.map((m) => {
          const meta = parseJson(m.ai_meta, null);
          return { id: m.id, sender_role: m.sender_role, content: m.content, created_at: m.created_at,
            citations: meta?.citations ?? [], options: meta?.options ?? null };
        }),
      },
    };
  });

  // ---- Triage Engine ----
  router.post('/v1/ai/triage', async (ctx) => {
    requireUser(ctx, 'patient');
    const { symptoms } = ctx.body;
    if (!Array.isArray(symptoms) || symptoms.length < 1 || symptoms.length > 20) throw badRequest('symptoms باید آرایه‌ای با حداقل یک مورد باشد');
    for (const s of symptoms) {
      if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 300) throw badRequest('هر علامت باید name داشته باشد');
      if (s.duration_hours != null && (!Number.isInteger(s.duration_hours) || s.duration_hours < 0)) throw badRequest('duration_hours نامعتبر است');
      if (s.severity != null && (!Number.isInteger(s.severity) || s.severity < 1 || s.severity > 10)) throw badRequest('severity باید بین ۱ تا ۱۰ باشد');
    }
    const r = assistant.runTriage(ctx, {
      userId: ctx.user.sub, patientId: ctx.user.pid,
      input: { symptoms: symptoms.map(({ name, duration_hours, severity }) => ({ name, duration_hours, severity })) },
    });
    platform.audit(ctx, 'triage.assess', `triage:${r.id}`, { urgency_level: r.urgency_level });
    return {
      body: { id: r.id, urgency_level: r.urgency_level, recommended_specialty: r.recommended_specialty,
        red_flags: r.red_flags, rule_version: r.rule_version, model_version: r.model_version },
    };
  });

  // Doctor review of triage (human-in-the-loop).
  router.post('/v1/triage/:id/review', async (ctx) => {
    requireUser(ctx, 'doctor');
    const t = db.get('SELECT * FROM triage_results WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!t) throw notFound('نتیجه triage');
    const linked = db.get('SELECT 1 FROM appointments WHERE triage_result_id = ? AND doctor_id = ?', t.id, ctx.user.did);
    if (!linked) throw forbidden('فقط پزشک معالج می‌تواند این triage را بازبینی کند', 'no_care_relationship');
    const agreed = ctx.body.agreed !== false;
    const note = ctx.body.note ? String(ctx.body.note).slice(0, 1000) : null;
    db.run('UPDATE triage_results SET reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
      ctx.user.did, nowIso(), JSON.stringify({ agreed, note, corrected_urgency: ctx.body.corrected_urgency ?? null }), t.id);
    platform.audit(ctx, 'triage.review', `triage:${t.id}`, { agreed });
    return { body: { id: t.id, reviewed: true, agreed } };
  });

  // ---- Operator console ----
  const requireStaff = (ctx) => requireUser(ctx, 'operator', 'admin');

  router.get('/v1/escalations', async (ctx) => {
    requireStaff(ctx);
    const status = ctx.query.status === 'resolved' ? 'resolved' : 'open';
    const rows = db.all(
      `SELECT e.*, u.full_name, u.phone, s.mode FROM escalations e
       JOIN users u ON u.id = e.user_id JOIN chat_sessions s ON s.id = e.session_id
       WHERE e.tenant_id = ? AND e.status = ?
       ORDER BY CASE e.kind WHEN 'emergency' THEN 0 ELSE 1 END, e.created_at DESC LIMIT 100`,
      ctx.tenantId, status,
    );
    return { body: { items: rows } };
  });

  const loadEsc = (ctx) => {
    const e = db.get('SELECT * FROM escalations WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!e) throw notFound('درخواست');
    return e;
  };

  router.get('/v1/escalations/:id', async (ctx) => {
    requireStaff(ctx);
    const e = loadEsc(ctx);
    platform.audit(ctx, 'escalation.read', `escalation:${e.id}`);
    const msgs = db.all(
      `SELECT id, sender_role, content, created_at FROM messages WHERE thread_id = ? AND thread_kind = 'ai' ORDER BY created_at, rowid`,
      e.session_id,
    );
    const user = db.get('SELECT full_name, phone FROM users WHERE id = ?', e.user_id);
    const session = db.get('SELECT mode FROM chat_sessions WHERE id = ?', e.session_id);
    return { body: { ...e, user, mode: session?.mode, messages: msgs } };
  });

  router.post('/v1/escalations/:id/messages', async (ctx) => {
    requireStaff(ctx);
    const e = loadEsc(ctx);
    const text = String(ctx.body.content ?? '').trim();
    if (!text || text.length > 2000) throw badRequest('متن پیام نامعتبر است');
    const id = uuid();
    db.run(
      `INSERT INTO messages (id, tenant_id, thread_id, thread_kind, sender_id, sender_role, content, created_at)
       VALUES (?,?,?,'ai',?,'operator',?,?)`, id, ctx.tenantId, e.session_id, ctx.user.sub, text, nowIso(),
    );
    platform.audit(ctx, 'escalation.reply', `escalation:${e.id}`);
    return { status: 201, body: { id } };
  });

  // Leaving EMERGENCY_MODE requires a human (design doc §4.4).
  router.post('/v1/escalations/:id/resolve', async (ctx) => {
    requireStaff(ctx);
    const e = loadEsc(ctx);
    if (e.status === 'resolved') return { body: { id: e.id, status: 'resolved' } };
    const ts = nowIso();
    db.tx(() => {
      db.run(`UPDATE escalations SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?`, ctx.user.sub, ts, e.id);
      const s = db.get('SELECT mode FROM chat_sessions WHERE id = ?', e.session_id);
      const otherOpenEmergency = db.get(`SELECT 1 FROM escalations WHERE session_id = ? AND status = 'open' AND kind = 'emergency'`, e.session_id);
      if (s?.mode === 'EMERGENCY_MODE' && !otherOpenEmergency) {
        db.run(`UPDATE chat_sessions SET mode = 'INFO_MODE', state = '{}', updated_at = ? WHERE id = ?`, ts, e.session_id);
        db.run(
          `INSERT INTO messages (id, tenant_id, thread_id, thread_kind, sender_id, sender_role, content, created_at)
           VALUES (?,?,?,'ai',?,'system',?,?)`, uuid(), ctx.tenantId, e.session_id, ctx.user.sub,
          'وضعیت اورژانس توسط اپراتور بررسی و بسته شد. دستیار دوباره در دسترس است.', ts,
        );
      }
    });
    platform.audit(ctx, 'escalation.resolve', `escalation:${e.id}`, { note: ctx.body.note ?? null });
    return { body: { id: e.id, status: 'resolved' } };
  });

  // ---- Admin ----
  router.get('/v1/admin/audit', async (ctx) => {
    requireUser(ctx, 'admin');
    const before = Number(ctx.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.all('SELECT * FROM audit_logs WHERE tenant_id = ? AND id < ? ORDER BY id DESC LIMIT 100', ctx.tenantId, before);
    return { body: { items: rows.map((r) => ({ ...r, detail: parseJson(r.detail, null) })) } };
  });

  router.get('/v1/admin/stats', async (ctx) => {
    requireUser(ctx, 'admin', 'operator');
    const one = (sql, ...p) => Object.values(db.get(sql, ...p))[0];
    return {
      body: {
        patients: one('SELECT COUNT(*) FROM patients WHERE tenant_id = ? AND deleted_at IS NULL', ctx.tenantId),
        doctors: one('SELECT COUNT(*) FROM doctors WHERE tenant_id = ? AND deleted_at IS NULL', ctx.tenantId),
        appointments_active: one(`SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND status IN ('pending','confirmed')`, ctx.tenantId),
        appointments_by_ai: one(`SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND booked_via = 'ai_assistant'`, ctx.tenantId),
        triage_by_level: db.all('SELECT urgency_level, COUNT(*) AS n FROM triage_results WHERE tenant_id = ? GROUP BY urgency_level', ctx.tenantId),
        escalations_open: one(`SELECT COUNT(*) FROM escalations WHERE tenant_id = ? AND status = 'open'`, ctx.tenantId),
      },
    };
  });
}
