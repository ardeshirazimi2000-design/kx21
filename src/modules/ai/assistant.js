// AI Assistant orchestrator (LangGraph in production): a five-state machine where urgency is
// decided by the rule-based Triage Engine, every clinical action is a doctor's, and every tool
// call is gated by mode, consent and explicit confirmation (design doc §4).
import { ApiError } from '../../lib/http.js';
import { uuid, nowIso, parseJson } from '../../lib/db.js';
import { sha256 } from '../../lib/crypto.js';
import { formatFaDateTime, toFaDigits } from '../../lib/fa.js';
import { maskSensitive } from '../../lib/platform.js';
import { SPECIALTIES } from '../patient.js';
import { classify } from './intent.js';
import { assess, detectEmergency, RULE_VERSION } from './triage.js';
import { checkOutput, EMERGENCY_TEMPLATE, EMERGENCY_HOLD } from './guardrails.js';
import { kbIndex, KB_VERSION } from './kb.js';

export const MODES = ['INFO_MODE', 'TRIAGE_MODE', 'BOOKING_MODE', 'EMERGENCY_MODE', 'FOLLOWUP_MODE'];
const RETRIEVAL_MIN_CONFIDENCE = 0.6;
const FOLLOWUP_DAYS = 7;
const MAX_OFFERS = 3;

const URGENCY_FA = { self_care: 'مراقبت در منزل', routine: 'غیرفوری', urgent: 'نیازمند ویزیت در اولین فرصت', emergency: 'اورژانسی' };

export function createAssistant({ db, platform, domain, llm, config }) {
  // ---------------- triage engine (service boundary) ----------------
  function runTriage(ctx, { userId, patientId, input }) {
    const r = assess(input);
    const id = uuid();
    db.run(
      `INSERT INTO triage_results (id, tenant_id, patient_id, user_id, symptoms, urgency_level, recommended_specialty,
         red_flags, rule_version, model_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.tenantId, patientId ?? null, userId, JSON.stringify(input.symptoms), r.urgency_level,
      r.recommended_specialty, JSON.stringify(r.red_flags), r.rule_version, null, nowIso(),
    );
    platform.publish(ctx, 'triage.completed', { triage_result_id: id, urgency_level: r.urgency_level, user_id: userId });
    return { id, ...r, model_version: null };
  }

  // ---------------- tools ----------------
  const TOOLS = {
    check_availability: {
      modes: ['BOOKING_MODE', 'FOLLOWUP_MODE'],
      run: (ctx, _s, { specialty, doctor_id, limit = MAX_OFFERS }) => {
        const slots = domain.appointment.checkAvailability(ctx.tenantId, { specialty, doctorId: doctor_id, limit: 30 });
        // Spread offers across doctors/times instead of three consecutive slots of one doctor.
        const picked = [];
        const seenDoctor = new Set();
        for (const s of slots) {
          if (picked.length >= limit) break;
          if (!doctor_id && seenDoctor.has(s.doctor_id) && slots.some((x) => !seenDoctor.has(x.doctor_id) && !picked.includes(x))) continue;
          picked.push(s);
          seenDoctor.add(s.doctor_id);
        }
        for (const s of slots) { if (picked.length >= limit) break; if (!picked.includes(s)) picked.push(s); }
        picked.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        return { slots: picked };
      },
    },
    book_appointment: {
      modes: ['BOOKING_MODE'],
      run: (ctx, session, { slot, triage_result_id, confirmed }) => {
        if (!confirmed) throw new ApiError(412, 'confirmation_required', 'رزرو بدون تأیید صریح بیمار مجاز نیست');
        if (!ctx.user.pid) throw new ApiError(404, 'profile_incomplete', 'پروفایل بیمار تکمیل نشده است');
        const { appointment, replayed } = domain.appointment.book(ctx, {
          patientId: ctx.user.pid, doctorId: slot.doctor_id, slotId: slot.id, channel: 'video',
          idempotencyKey: sha256(`${session.id}:${slot.id}`).slice(0, 64), bookedVia: 'ai_assistant',
          triageResultId: triage_result_id ?? null,
        });
        return { appointment_id: appointment.id, replayed };
      },
    },
    fetch_patient_history: {
      modes: ['TRIAGE_MODE'],
      run: (ctx) => {
        if (!ctx.user.pid || !domain.patient.activeConsent(ctx.user.pid, 'ai_history_access')) {
          throw new ApiError(403, 'consent_required', 'رضایت دسترسی دستیار به سوابق فعال نیست');
        }
        const p = db.get('SELECT dob, allergies, chronic_conditions FROM patients WHERE id = ?', ctx.user.pid);
        platform.audit(ctx, 'patient.read', `patient:${ctx.user.pid}`, { by: 'ai_assistant' });
        const age = p?.dob ? (Date.now() - Date.parse(p.dob)) / (365.25 * 864e5) : null;
        return {
          age_years: age && Math.floor(age * 10) / 10,
          allergies: parseJson(p?.allergies, []),
          chronic_conditions: parseJson(p?.chronic_conditions, []),
        };
      },
    },
    create_prescription_draft: {
      modes: MODES,
      roles: ['doctor'], // only in a doctor's session; the draft is invalid until the doctor signs it
      run: (ctx, _s, { consultation_id, drugs, notes }) => {
        const { rx } = domain.prescription.createDraft(ctx, {
          consultationId: consultation_id, drugs, notes, idempotencyKey: `ai:${sha256(JSON.stringify([consultation_id, drugs]))}`.slice(0, 64),
        });
        return { prescription_id: rx.id, status: 'draft' };
      },
    },
    escalate_to_human: {
      modes: MODES,
      run: (ctx, session, { kind, reason }) => {
        const open = db.get(`SELECT id FROM escalations WHERE session_id = ? AND status = 'open' AND kind = ?`, session.id, kind);
        if (open) return { escalation_id: open.id, existing: true };
        const id = uuid();
        db.run(
          'INSERT INTO escalations (id, tenant_id, session_id, user_id, kind, reason, created_at) VALUES (?,?,?,?,?,?,?)',
          id, ctx.tenantId, session.id, session.user_id, kind, String(reason).slice(0, 500), nowIso(),
        );
        platform.publish(ctx, 'ai.escalated', { escalation_id: id, session_id: session.id, kind });
        const ops = db.all(`SELECT id, phone FROM users WHERE tenant_id = ? AND role IN ('operator') AND deleted_at IS NULL`, ctx.tenantId);
        for (const o of ops) {
          platform.notify(ctx, {
            userId: o.id, channel: kind === 'emergency' ? 'sms' : 'push', target: o.phone,
            body: kind === 'emergency' ? `🚨 escalation اورژانسی در گفتگوی دستیار — فوراً بررسی کنید` : `درخواست جدید پشتیبانی انسانی (${kind})`,
          });
        }
        return { escalation_id: id, existing: false };
      },
    },
  };

  function callTool(ctx, session, turn, name, args) {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`unknown tool ${name}`);
    if (!tool.modes.includes(session.mode)) {
      throw new Error(`tool ${name} is not allowed in ${session.mode}`); // programming error; never user-triggered
    }
    if (tool.roles && !tool.roles.includes(ctx.user.role)) throw new ApiError(403, 'forbidden', `ابزار ${name} برای این نقش مجاز نیست`);
    const record = { name, args: maskSensitive(args), status: 'ok' };
    turn.emit('tool_call', { name, status: 'started' });
    try {
      const result = tool.run(ctx, session, args);
      record.result = summarizeResult(name, result);
      turn.emit('tool_call', { name, status: 'ok', result: record.result });
      return result;
    } catch (e) {
      record.status = 'error';
      record.error = e.code || e.message;
      turn.emit('tool_call', { name, status: 'error', error: record.error });
      throw e;
    } finally {
      turn.tools.push(record);
      platform.audit(ctx, `ai.tool.${name}`, `ai_session:${session.id}`, record);
    }
  }

  const summarizeResult = (name, r) =>
    name === 'check_availability' ? { count: r.slots.length } : name === 'fetch_patient_history' ? { fields: Object.keys(r) } : r;

  // ---------------- session state ----------------
  function loadSession(ctx, sessionId) {
    let s = db.get('SELECT * FROM chat_sessions WHERE id = ?', sessionId);
    if (s && (s.user_id !== ctx.user.sub || s.tenant_id !== ctx.tenantId)) throw new ApiError(403, 'forbidden', 'این گفتگو متعلق به شما نیست');
    if (!s) {
      const ts = nowIso();
      db.run('INSERT INTO chat_sessions (id, tenant_id, user_id, mode, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        sessionId, ctx.tenantId, ctx.user.sub, 'INFO_MODE', '{}', ts, ts);
      s = db.get('SELECT * FROM chat_sessions WHERE id = ?', sessionId);
    }
    return { ...s, state: parseJson(s.state, {}) };
  }

  function saveSession(session) {
    db.run('UPDATE chat_sessions SET mode = ?, state = ?, updated_at = ? WHERE id = ?',
      session.mode, JSON.stringify(session.state), nowIso(), session.id);
  }

  function setMode(session, turn, to, reason) {
    if (session.mode === to) return;
    turn.emit('mode_change', { from: session.mode, to, reason });
    turn.modes.push(`${session.mode}->${to}`);
    session.mode = to;
  }

  const saveMessage = (ctx, session, senderRole, content, aiMeta = null) => {
    const id = uuid();
    db.run(
      `INSERT INTO messages (id, tenant_id, thread_id, thread_kind, sender_id, sender_role, content, ai_meta, created_at)
       VALUES (?,?,?,'ai',?,?,?,?,?)`,
      id, ctx.tenantId, session.id, senderRole === 'patient' ? ctx.user.sub : null, senderRole, content,
      aiMeta ? JSON.stringify(aiMeta) : null, nowIso(),
    );
    return id;
  };

  // ---------------- handlers ----------------
  function enterEmergency(ctx, session, turn, flags, sourceText) {
    setMode(session, turn, 'EMERGENCY_MODE', 'red_flag');
    const t = runTriage(ctx, {
      userId: ctx.user.sub, patientId: ctx.user.pid,
      input: { symptoms: [{ name: sourceText.slice(0, 500) }], free_text: sourceText },
    });
    const esc = callTool(ctx, session, turn, 'escalate_to_human', { kind: 'emergency', reason: `red flags: ${flags.join(', ')}` });
    turn.emit('escalation', { escalation_id: esc.escalation_id, kind: 'emergency', emergency_number: '115' });
    session.state = { emergency: { flags, triage_result_id: t.id, escalation_id: esc.escalation_id } };
    turn.reply(EMERGENCY_TEMPLATE(flags), { fixed_template: 'emergency_v1' });
  }

  async function handleInfo(ctx, session, turn, nlu, text) {
    const st = session.state;
    switch (nlu.intent) {
      case 'greeting':
        return turn.reply(
          'سلام! من دستیار هوشمند ویزیت آنلاین هستم. می‌توانم به پرسش‌های عمومی پاسخ بدهم، علائم شما را برای تعیین فوریت بررسی کنم و برایتان نوبت بگیرم. ' +
          'توجه کنید که تشخیص و تجویز فقط با پزشک است. چه کمکی از دستم برمی‌آید؟',
        );
      case 'thanks':
        return turn.reply('خواهش می‌کنم. اگر سؤال دیگری داشتید در خدمتم.');
      case 'symptom_report':
        setMode(session, turn, 'TRIAGE_MODE', 'symptom_reported');
        session.state = { triage: newTriageState() };
        return handleTriage(ctx, session, turn, nlu, text);
      case 'booking_request':
        setMode(session, turn, 'BOOKING_MODE', 'booking_requested');
        session.state = { booking: { specialty: nlu.entities.specialty ?? null } };
        return handleBooking(ctx, session, turn, nlu, text);
      case 'affirm':
        if (st.pendingOffer) {
          setMode(session, turn, 'BOOKING_MODE', 'accepted_offer');
          session.state = { booking: { ...st.pendingOffer } };
          return handleBooking(ctx, session, turn, { ...nlu, intent: 'booking_request' }, text);
        }
        return turn.reply('بسیار خب. چه کمکی می‌توانم بکنم؟');
      case 'deny':
        session.state = {};
        return turn.reply('باشه. هر زمان نیاز داشتید در خدمتم.');
      default:
        return answerFromKb(ctx, session, turn, text);
    }
  }

  async function answerFromKb(ctx, session, turn, text) {
    const hits = kbIndex.search(text, 3);
    turn.retrieval = hits.map((h) => ({ id: h.id, confidence: Number(h.confidence.toFixed(3)) }));
    const usable = hits.filter((h) => h.confidence >= RETRIEVAL_MIN_CONFIDENCE);
    if (!usable.length) {
      // Low retrieval confidence → escalate instead of guessing (design doc §4.5).
      const esc = callTool(ctx, session, turn, 'escalate_to_human', { kind: 'low_confidence', reason: text.slice(0, 300) });
      turn.emit('escalation', { escalation_id: esc.escalation_id, kind: 'low_confidence' });
      return turn.reply(
        'برای این پرسش پاسخ تأییدشده‌ای در منابع من نیست و نمی‌خواهم حدس بزنم. پرسش شما برای همکار انسانی ارسال شد و در همین گفتگو پاسخ می‌دهد. ' +
        'اگر علامت یا ناراحتی دارید، آن را توضیح دهید تا فوریتش را بررسی کنم.',
      );
    }
    const gen = await llm.generate({ question: text, chunks: usable });
    turn.model_version = gen.model_version;
    turn.citations = usable.slice(0, 2).map((h) => ({ id: h.id, title: h.title, kb_version: KB_VERSION }));
    return turn.reply(gen.text);
  }

  const newTriageState = () => ({ symptoms: [], asked: [] });

  async function handleTriage(ctx, session, turn, nlu, text) {
    const tr = session.state.triage ?? (session.state.triage = newTriageState());
    const e = nlu.entities;
    if (nlu.intent === 'deny' && !tr.symptoms.length) {
      setMode(session, turn, 'INFO_MODE', 'cancelled');
      session.state = {};
      return turn.reply('باشه. اگر علامتی داشتید، هر زمان بگویید.');
    }
    if (['symptom_report', 'general_question', 'booking_request'].includes(nlu.intent) || !tr.symptoms.length) {
      tr.symptoms.push({ name: text.slice(0, 300) });
    }
    if (e.duration_hours != null) tr.duration_hours = e.duration_hours;
    if (e.severity != null) tr.severity = e.severity;
    if (e.age_years != null) tr.age_years = e.age_years;
    if (e.bare_number != null && tr.awaiting === 'severity') tr.severity = e.bare_number;
    if (tr.awaiting === 'severity' && tr.severity == null && nlu.intent === 'deny') tr.severity = 0;
    tr.awaiting = null;

    if (tr.severity == null && !tr.asked.includes('severity')) {
      tr.asked.push('severity');
      tr.awaiting = 'severity';
      return turn.reply('متوجه شدم. شدت ناراحتی‌تان از ۱ (خیلی خفیف) تا ۱۰ (غیرقابل تحمل) چند است؟');
    }
    if (tr.duration_hours == null && !tr.asked.includes('duration')) {
      tr.asked.push('duration');
      tr.awaiting = 'duration';
      return turn.reply('از چه زمانی این علائم را دارید؟ (مثلاً «از دیروز» یا «۳ روز»)');
    }

    let history = null;
    if (ctx.user.pid && domain.patient.activeConsent(ctx.user.pid, 'ai_history_access')) {
      history = callTool(ctx, session, turn, 'fetch_patient_history', {});
    }
    const input = {
      symptoms: tr.symptoms.map((s) => ({ name: s.name, duration_hours: tr.duration_hours ?? undefined, severity: tr.severity || undefined })),
      free_text: tr.symptoms.map((s) => s.name).join(' | '),
      age_years: tr.age_years ?? history?.age_years ?? undefined,
      chronic_conditions: history?.chronic_conditions ?? [],
    };
    turn.emit('tool_call', { name: 'triage_engine.assess', status: 'started' });
    const result = runTriage(ctx, { userId: ctx.user.sub, patientId: ctx.user.pid, input });
    turn.emit('tool_call', { name: 'triage_engine.assess', status: 'ok', result: { urgency_level: result.urgency_level, rule_version: RULE_VERSION } });
    turn.tools.push({ name: 'triage_engine.assess', status: 'ok', result: { id: result.id, urgency_level: result.urgency_level } });
    turn.triage = { id: result.id, urgency_level: result.urgency_level, rule_version: result.rule_version };

    if (result.urgency_level === 'emergency') return enterEmergency(ctx, session, turn, result.red_flags, input.free_text);

    const spLabel = SPECIALTIES[result.recommended_specialty];
    const head = `ارزیابی اولیه (بر اساس قواعد تأییدشده، نه تشخیص): سطح فوریت «${URGENCY_FA[result.urgency_level]}» و تخصص پیشنهادی «${spLabel}».`;
    const offer = { specialty: result.recommended_specialty, triage_result_id: result.id, urgency: result.urgency_level };

    if (result.urgency_level === 'self_care') {
      setMode(session, turn, 'INFO_MODE', 'triage_self_care');
      session.state = { pendingOffer: offer };
      const tip = kbIndex.search(input.free_text, 1)[0];
      if (tip) turn.citations = [{ id: tip.id, title: tip.title, kb_version: KB_VERSION }];
      return turn.reply(`${head}\n${tip ? tip.text + '\n' : ''}اگر علائم بدتر شد یا مایل به مشورت با پزشک هستید، بگویید «بله» تا برایتان نوبت بگیرم.`);
    }

    setMode(session, turn, 'BOOKING_MODE', 'triage_' + result.urgency_level);
    session.state = { booking: offer };
    turn.prefix = `${head}${result.urgency_level === 'urgent' ? '\nتوصیه می‌شود در اولین فرصت ویزیت شوید؛ اگر حالتان بدتر شد با ۱۱۵ تماس بگیرید.' : ''}`;
    return handleBooking(ctx, session, turn, { ...nlu, intent: 'booking_request' }, text);
  }

  function offerSlots(ctx, session, turn, b) {
    const { slots } = callTool(ctx, session, turn, 'check_availability', { specialty: b.doctor_id ? undefined : b.specialty, doctor_id: b.doctor_id });
    if (!slots.length) {
      const prevMode = session.mode;
      setMode(session, turn, 'INFO_MODE', 'no_availability');
      session.state = {};
      const esc = callTool(ctx, session, turn, 'escalate_to_human', { kind: 'human_request', reason: `no availability (${b.specialty ?? b.doctor_id}) from ${prevMode}` });
      turn.emit('escalation', { escalation_id: esc.escalation_id, kind: 'human_request' });
      return turn.reply(`در حال حاضر زمان آزادی برای «${SPECIALTIES[b.specialty] ?? 'این پزشک'}» پیدا نکردم. درخواست شما برای اپراتور ارسال شد تا هماهنگی کند.`);
    }
    b.offered = slots.map((s) => ({ id: s.id, doctor_id: s.doctor_id, doctor_name: s.doctor_name, starts_at: s.starts_at, specialty: s.specialty }));
    b.stage = 'choose';
    turn.options = b.offered.map((s, i) => ({ option: i + 1, slot_id: s.id, doctor_name: s.doctor_name, starts_at: s.starts_at }));
    const lines = b.offered.map((s, i) => `${toFaDigits(i + 1)}. ${s.doctor_name} (${SPECIALTIES[s.specialty]}) — ${formatFaDateTime(s.starts_at)}`);
    return turn.reply(`این زمان‌ها آزاد است:\n${lines.join('\n')}\nشماره گزینه مورد نظر را بنویسید.`);
  }

  async function handleBooking(ctx, session, turn, nlu, text) {
    const b = session.state.booking ?? (session.state.booking = {});
    if (nlu.intent === 'deny' || nlu.intent === 'cancel_request') {
      setMode(session, turn, 'INFO_MODE', 'booking_cancelled');
      session.state = {};
      return turn.reply('باشه، رزرو انجام نشد. اگر بعداً خواستید بگویید.');
    }
    if (nlu.entities.specialty && !b.stage) b.specialty = nlu.entities.specialty;

    if (!b.specialty && !b.doctor_id) {
      if (nlu.intent === 'symptom_report') {
        setMode(session, turn, 'TRIAGE_MODE', 'symptom_reported');
        session.state = { triage: newTriageState() };
        return handleTriage(ctx, session, turn, nlu, text);
      }
      if (!b.askedSpecialty) {
        b.askedSpecialty = true;
        const list = Object.values(SPECIALTIES).slice(0, 8).join('، ');
        return turn.reply(`برای چه تخصصی نوبت می‌خواهید؟ (مثلاً ${list}) یا علائم‌تان را بگویید تا تخصص مناسب را پیشنهاد کنم.`);
      }
      b.specialty = 'general';
    }

    if (!b.stage) return offerSlots(ctx, session, turn, b);

    if (b.stage === 'choose') {
      const n = nlu.entities.option ?? nlu.entities.bare_number;
      if (n && n >= 1 && n <= b.offered.length) {
        b.selected = b.offered[n - 1];
        b.stage = 'confirm';
        return turn.reply(`نوبت ویزیت ویدیویی با ${b.selected.doctor_name} در ${formatFaDateTime(b.selected.starts_at)}. آیا رزرو را تأیید می‌کنید؟ (بله / خیر)`);
      }
      return turn.reply(`لطفاً شماره یکی از گزینه‌ها (۱ تا ${toFaDigits(b.offered.length)}) را بنویسید یا «انصراف».`);
    }

    if (b.stage === 'confirm') {
      if (nlu.intent !== 'affirm') {
        return turn.reply('برای ثبت نوبت تأیید صریح لازم است. «بله» برای تأیید یا «خیر» برای انصراف.');
      }
      try {
        const r = callTool(ctx, session, turn, 'book_appointment', { slot: b.selected, triage_result_id: b.triage_result_id, confirmed: true });
        turn.booked = r.appointment_id;
        const slot = b.selected;
        setMode(session, turn, 'INFO_MODE', 'booked');
        session.state = {};
        return turn.reply(`✅ نوبت شما با ${slot.doctor_name} برای ${formatFaDateTime(slot.starts_at)} ثبت شد. پیامک تأیید ارسال شد و از بخش «نوبت‌های من» می‌توانید وارد اتاق ویزیت شوید.`);
      } catch (e) {
        if (e.code === 'slot_taken' || e.code === 'slot_in_past') {
          b.stage = null;
          turn.prefix = 'متأسفانه این زمان همین الان رزرو شد. گزینه‌های جدید:';
          return offerSlots(ctx, session, turn, b);
        }
        if (e.code === 'consent_required' || e.code === 'profile_incomplete') {
          return turn.reply(`${e.message}. پس از تکمیل از بخش «پروفایل / حریم خصوصی»، دوباره «بله» بنویسید تا رزرو انجام شود.`);
        }
        throw e;
      }
    }
    b.stage = null;
    return offerSlots(ctx, session, turn, b);
  }

  async function handleFollowup(ctx, session, turn, nlu, text) {
    const f = session.state.followup;
    if (!f || f.until < nowIso()) {
      setMode(session, turn, 'INFO_MODE', 'followup_expired');
      session.state = {};
      return handleInfo(ctx, session, turn, nlu, text);
    }
    if (nlu.intent === 'booking_request' || nlu.intent === 'affirm') {
      const doc = db.get('SELECT specialty FROM doctors WHERE id = ?', f.doctor_id);
      setMode(session, turn, 'BOOKING_MODE', 'followup_booking');
      session.state = { booking: { doctor_id: f.doctor_id, specialty: doc?.specialty } };
      return handleBooking(ctx, session, turn, nlu, text);
    }
    if (nlu.intent === 'symptom_report') {
      setMode(session, turn, 'TRIAGE_MODE', 'followup_new_symptom');
      session.state = { triage: newTriageState() };
      return handleTriage(ctx, session, turn, nlu, text);
    }
    if (nlu.intent === 'general_question') return answerFromKb(ctx, session, turn, text);
    return turn.reply('اگر پس از ویزیت سؤالی دارید یا علائم تغییر کرده، بنویسید. برای ویزیت پیگیری با همان پزشک بگویید «نوبت پیگیری».');
  }

  // ---------------- main entry ----------------
  const busy = new Set();

  async function processMessage(ctx, sessionId, text, emit) {
    if (busy.has(sessionId)) throw new ApiError(409, 'session_busy', 'پیام قبلی هنوز در حال پردازش است');
    busy.add(sessionId);
    try {
      const session = loadSession(ctx, sessionId);
      const turn = {
        tools: [], modes: [], citations: [], retrieval: [], options: null, prefix: null, text: null, meta: {},
        emit,
        reply(t, meta = {}) { this.text = this.prefix ? `${this.prefix}\n${t}` : t; Object.assign(this.meta, meta); },
      };
      saveMessage(ctx, session, 'patient', text);

      const nlu = classify(text);
      const flags = detectEmergency(text); // fixed rule, before any model
      if (session.mode === 'EMERGENCY_MODE') {
        turn.reply(EMERGENCY_HOLD, { fixed_template: 'emergency_hold_v1' });
      } else if (flags.length) {
        enterEmergency(ctx, session, turn, flags, text);
      } else if (nlu.intent === 'human_request') {
        const esc = callTool(ctx, session, turn, 'escalate_to_human', { kind: 'human_request', reason: text.slice(0, 300) });
        emit('escalation', { escalation_id: esc.escalation_id, kind: 'human_request' });
        turn.reply('درخواست شما برای اپراتور انسانی ارسال شد. پاسخ اپراتور در همین گفتگو نمایش داده می‌شود.');
      } else if (nlu.intent === 'cancel_request' && session.mode !== 'BOOKING_MODE') {
        turn.reply('برای لغو یا جابه‌جایی نوبت، از بخش «نوبت‌های من» روی دکمه «لغو» بزنید. پس از لغو پیامک تأیید دریافت می‌کنید.');
      } else if (session.mode === 'TRIAGE_MODE') {
        await handleTriage(ctx, session, turn, nlu, text);
      } else if (session.mode === 'BOOKING_MODE') {
        await handleBooking(ctx, session, turn, nlu, text);
      } else if (session.mode === 'FOLLOWUP_MODE') {
        await handleFollowup(ctx, session, turn, nlu, text);
      } else {
        await handleInfo(ctx, session, turn, nlu, text);
      }

      // Output guardrail on every generated (non-template) response.
      let reply = turn.text ?? 'متوجه نشدم؛ لطفاً دوباره توضیح دهید.';
      let guardrail = null;
      if (!turn.meta.fixed_template) {
        const g = checkOutput(reply);
        if (!g.ok) {
          guardrail = { blocked: true, rule: g.rule };
          reply = g.replacement;
          turn.citations = [];
        }
      }

      const aiMeta = {
        trace_id: ctx.traceId, intent: nlu.intent, intent_confidence: nlu.confidence, mode: session.mode,
        mode_changes: turn.modes, tools: turn.tools.map((t) => ({ name: t.name, status: t.status })),
        retrieval: turn.retrieval, citations: turn.citations.map((c) => c.id), triage: turn.triage ?? null,
        model_version: turn.model_version ?? 'template-v1', guardrail, options: turn.options,
      };
      saveSession(session);
      const messageId = saveMessage(ctx, session, 'assistant', reply, aiMeta);
      platform.audit(ctx, 'ai.turn', `ai_session:${session.id}`, {
        message_id: messageId, prompt_sha256: sha256(text), response_sha256: sha256(reply), ...aiMeta,
      });

      // Stream the (already guarded) reply token by token.
      const tokens = reply.match(/\S+\s*|\n/g) ?? [reply];
      for (const tok of tokens) {
        emit('token', { text: tok });
        if (config.streamDelayMs) await new Promise((r) => setTimeout(r, config.streamDelayMs));
      }
      for (const c of turn.citations) emit('citation', c);
      if (turn.options) emit('options', { items: turn.options });
      emit('done', { message_id: messageId, mode: session.mode, trace_id: ctx.traceId, booked_appointment_id: turn.booked ?? null });
      return { messageId, mode: session.mode, reply };
    } finally {
      busy.delete(sessionId);
    }
  }

  // consultation.ended → move the patient's latest chat session into FOLLOWUP_MODE.
  platform.subscribe('consultation.ended', (e, ctx) => {
    const p = db.get('SELECT user_id FROM patients WHERE id = ?', e.patient_id);
    if (!p) return;
    const fctx = { ...ctx, tenantId: e.tenant_id, user: { sub: p.user_id } };
    let s = db.get(`SELECT * FROM chat_sessions WHERE user_id = ? AND mode != 'EMERGENCY_MODE' ORDER BY updated_at DESC LIMIT 1`, p.user_id);
    if (!s) {
      const id = uuid();
      db.run('INSERT INTO chat_sessions (id, tenant_id, user_id, mode, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        id, e.tenant_id, p.user_id, 'INFO_MODE', '{}', nowIso(), nowIso());
      s = db.get('SELECT * FROM chat_sessions WHERE id = ?', id);
    }
    const until = new Date(Date.now() + FOLLOWUP_DAYS * 864e5).toISOString();
    db.run('UPDATE chat_sessions SET mode = ?, state = ?, updated_at = ? WHERE id = ?', 'FOLLOWUP_MODE',
      JSON.stringify({ followup: { until, doctor_id: e.doctor_id, consultation_id: e.consultation_id } }), nowIso(), s.id);
    saveMessage(fctx, { id: s.id }, 'assistant',
      'ویزیت شما به پایان رسید. اگر نسخه صادر شده باشد در بخش «نسخه‌ها» است. تا یک هفته اگر سؤال یا علامت جدیدی داشتید همین‌جا بنویسید؛ برای ویزیت پیگیری بگویید «نوبت پیگیری».',
      { mode: 'FOLLOWUP_MODE', event: 'consultation.ended', trace_id: ctx.traceId ?? null });
  });

  return { processMessage, loadSession, callTool, TOOLS, runTriage };
}
