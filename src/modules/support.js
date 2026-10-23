// Support ("پشتیبانی"): the support assistant answers questions about using the system from the
// support knowledge base; when the user asks for a person, files a complaint, or the assistant
// cannot help, the conversation goes to the support team — staff with the permission
// support.handle — who answer in the "support desk" (دستیار پشتیبان).
import { badRequest, conflict, notFound, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { requireUser } from './auth.js';
import { buildIndex } from './ai/kb.js';
import { SUPPORT_KB } from '../lib/support-kb.js';
import { getVisitSettings, getSupportSettings } from '../lib/visit-settings.js';
import { toFaDigits } from '../lib/fa.js';

const ANSWER_MIN = 0.45; // retrieval confidence needed to answer instead of asking again
// Asking for a person, complaints and security reports go straight to the team.
const HUMAN = /کارشناس|اپراتور|انسان|آدم واقعی|فرد واقعی|تماس بگیر|زنگ بزن|شکایت|اعتراض|هک شد|نشت|سو[ءء]? ?استفاده|کلاهبرداری|حذف حساب/;
const DONE = /^(ممنون|مرسی|متشکر|سپاس|حل شد|مشکلم حل شد|اوکی|باشه|خداحافظ)/;
const GREETING = /^(سلام|درود|وقت بخیر|صبح بخیر|عصر بخیر|hi|hello)[\s!.،]*$/i;
const MEDICAL = /درد|تب\b|سرفه|علائم|علایم|بیماری|سردرد|تهوع|استفراغ|اسهال|حساسیت دارم|فشار خون|قند خون/;

const ACT = {
  escalate: { type: 'escalate', label: 'گفتگو با کارشناس پشتیبانی' },
  close: { type: 'close', label: 'مشکلم حل شد' },
};

// Ready-made staff role for support agents: the support desk only (no medical records, payments, …).
export const SUPPORT_ROLE = { name: 'کارشناس پشتیبانی', permissions: ['support.handle'] };
const RATE_DAYS = 14; // a closed conversation can be rated for this long

export function register(router, { db, platform, domain, limiter, config }) {
  for (const t of db.all('SELECT DISTINCT tenant_id FROM users').map((r) => r.tenant_id).concat(config.defaultTenant ?? []).filter(Boolean)) {
    if (!db.get('SELECT 1 FROM staff_roles WHERE tenant_id = ? AND name = ?', t, SUPPORT_ROLE.name)) {
      db.run('INSERT INTO staff_roles (id, tenant_id, name, permissions, created_at) VALUES (?,?,?,?,?)', uuid(), t, SUPPORT_ROLE.name, JSON.stringify(SUPPORT_ROLE.permissions), nowIso());
    }
  }
  const audienceOf = (role) => (role === 'doctor' ? 'doctor' : 'patient');
  const indexes = {
    patient: buildIndex(SUPPORT_KB.filter((d) => d.for !== 'doctor').map((d) => ({ id: d.id, title: d.title, text: `${d.keys} ${d.title}` }))),
    doctor: buildIndex(SUPPORT_KB.filter((d) => d.for !== 'patient').map((d) => ({ id: d.id, title: d.title, text: `${d.keys} ${d.title}` }))),
  };
  const byId = new Map(SUPPORT_KB.map((d) => [d.id, d]));
  const answerOf = (tenantId, id) => {
    const v = getVisitSettings(db, tenantId);
    return byId.get(id).text({ refundHours: v.cancel_refund_hours, joinEarly: v.join_early_min, holdMin: domain.payments?.HOLD_MIN ?? 15 });
  };
  const topicsFor = (role) => SUPPORT_KB.filter((d) => d.for === 'all' || d.for === audienceOf(role)).map((d) => ({ id: d.id, title: d.title }));
  const search = (role, text) => indexes[audienceOf(role)].search(text, 3);

  const roleOf = (userId) => db.get('SELECT role FROM users WHERE id = ?', userId)?.role;
  // staff: the desk sees which agent wrote each answer; the user sees «کارشناس پشتیبانی».
  const msgView = (m, { staff = false } = {}) => ({
    id: m.id, sender: m.sender, body: m.body, actions: parseJson(m.actions, []), created_at: m.created_at,
    ...(staff && m.staff_id ? { staff_name: m.staff_name ?? null } : {}),
  });
  const messagesOf = (ticketId, opts) => db.all(
    'SELECT m.*, u.full_name AS staff_name FROM support_messages m LEFT JOIN users u ON u.id = m.staff_id WHERE m.ticket_id = ? ORDER BY m.created_at, m.rowid', ticketId,
  ).map((m) => msgView(m, opts));
  const ticketView = (t) => t && {
    id: t.id, status: t.status, topic: t.topic, created_at: t.created_at, updated_at: t.updated_at, escalated_at: t.escalated_at, closed_at: t.closed_at,
    rating: t.rating ?? null, rating_comment: t.rating_comment ?? null,
  };
  // The latest conversation the support team answered, closed and not rated yet.
  const toRate = (ctx) => db.get(
    `SELECT t.id, t.topic FROM support_tickets t WHERE t.tenant_id = ? AND t.user_id = ? AND t.status = 'closed' AND t.rating IS NULL AND t.closed_at > ?
       ORDER BY t.closed_at DESC LIMIT 1`,
    ctx.tenantId, ctx.user.sub, new Date(Date.now() - RATE_DAYS * 864e5).toISOString(),
  ) ?? null;
  const openTicketOf = (ctx) => db.get(
    `SELECT * FROM support_tickets WHERE tenant_id = ? AND user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`, ctx.tenantId, ctx.user.sub,
  );
  const add = (ticketId, sender, body, { actions = null, staffId = null } = {}) => {
    const ts = nowIso();
    db.run('INSERT INTO support_messages (id, ticket_id, sender, staff_id, body, actions, created_at) VALUES (?,?,?,?,?,?,?)',
      uuid(), ticketId, sender, staffId, body, actions ? JSON.stringify(actions) : null, ts);
    db.run('UPDATE support_tickets SET updated_at = ? WHERE id = ?', ts, ticketId);
  };
  const setStatus = (id, status) => db.run('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);

  // Everyone allowed to answer support (admins without a staff role have every permission).
  const agents = (tenantId) => db.all(
    `SELECT id, phone FROM users WHERE tenant_id = ? AND role IN ('admin','operator') AND deleted_at IS NULL AND disabled_at IS NULL`, tenantId,
  ).filter((u) => domain.access.permissionsOf(u.id).perms.includes('support.handle'));

  function escalate(ctx, t, why) {
    if (t.status === 'waiting') return;
    db.run(`UPDATE support_tickets SET status = 'waiting', escalated_at = COALESCE(escalated_at, ?), updated_at = ? WHERE id = ?`, nowIso(), nowIso(), t.id);
    add(t.id, 'system', 'گفتگو به کارشناس پشتیبانی ارجاع شد. پاسخ کارشناس در همین بخش نمایش داده و به شما اعلان می‌شود؛ می‌توانید توضیحات بیشتر را همین‌جا بنویسید.');
    platform.audit(ctx, 'support.escalate', `support:${t.id}`, { why });
    const u = db.get('SELECT full_name, phone, role FROM users WHERE id = ?', t.user_id);
    for (const a of agents(t.tenant_id)) {
      platform.notify(ctx, { userId: a.id, channel: 'push', target: a.phone, body: `درخواست پشتیبانی جدید از ${u?.full_name || (u?.role === 'doctor' ? 'پزشک' : 'کاربر')}: ${t.topic ?? ''}`.slice(0, 200) });
    }
  }

  // The assistant's turn: answer from the knowledge base, or pass the conversation on.
  function botReply(ctx, t, text) {
    const role = roleOf(t.user_id);
    if (HUMAN.test(text)) return escalate(ctx, t, 'asked');
    if (DONE.test(text.trim())) {
      add(t.id, 'bot', 'خوشحالم که کمک کردم. اگر پرسش دیگری داشتید، همین‌جا بنویسید.', { actions: [ACT.close] });
      return;
    }
    if (GREETING.test(text.trim())) {
      add(t.id, 'bot', 'سلام، به پشتیبانی درمان پلاس خوش آمدید. پرسش خود را بنویسید یا یکی از موضوعات را انتخاب کنید.',
        { actions: topicsFor(role).slice(0, 6).map((x) => ({ type: 'topic', label: x.title, id: x.id })) });
      return;
    }
    const hits = search(role, text);
    const best = hits[0];
    if (best && best.confidence >= ANSWER_MIN) {
      db.run(`UPDATE support_tickets SET topic = COALESCE(topic, ?) WHERE id = ?`, best.title, t.id);
      const related = hits.slice(1).filter((h) => h.confidence >= 0.35).map((h) => ({ type: 'topic', label: h.title, id: h.id }));
      add(t.id, 'bot', answerOf(t.tenant_id, best.id), { actions: [...related, ACT.close, ACT.escalate] });
      return;
    }
    // Two misses in a row: a person takes over.
    const last = db.get(`SELECT body FROM support_messages WHERE ticket_id = ? AND sender = 'bot' ORDER BY created_at DESC, rowid DESC LIMIT 1`, t.id);
    if (last?.body.startsWith('پاسخ دقیقی')) {
      add(t.id, 'bot', 'متأسفانه نتوانستم پاسخ مناسب پیدا کنم.');
      return escalate(ctx, t, 'not_found');
    }
    const medical = role !== 'doctor' && MEDICAL.test(text)
      ? 'اگر پرسش شما پزشکی است (علائم، دارو یا درمان)، از «دستیار هوشمند» یا ویزیت با پزشک کمک بگیرید؛ در شرایط اورژانسی با ۱۱۵ تماس بگیرید.\n' : '';
    const suggest = hits.length ? hits : topicsFor(role).slice(0, 4).map((x) => ({ ...x }));
    add(t.id, 'bot', `${medical}پاسخ دقیقی برای این پرسش پیدا نکردم. یکی از موضوعات زیر را انتخاب کنید یا پرسش را با جزئیات بیشتری بنویسید؛ می‌توانید گفتگو را به کارشناس پشتیبانی هم ارجاع دهید.`,
      { actions: [...suggest.slice(0, 4).map((h) => ({ type: 'topic', label: h.title, id: h.id })), ACT.escalate] });
  }

  const state = (ctx) => {
    const t = openTicketOf(ctx);
    return { ticket: t ? ticketView(t) : null, messages: t ? messagesOf(t.id) : [], topics: topicsFor(ctx.user.role), // Rating is offered as soon as an agent has answered (and again after closing, if skipped).
      rate: t ? (t.status === 'answered' && t.rating == null ? { id: t.id, topic: t.topic } : null) : toRate(ctx) };
  };

  router.get('/v1/support', async (ctx) => {
    requireUser(ctx);
    return { body: state(ctx) };
  });

  // { body } — a question, or { topic } — a topic button.
  router.post('/v1/support/messages', async (ctx) => {
    requireUser(ctx);
    limiter.hit(`support:${ctx.user.sub}`, 40, 10 * 60 * 1000);
    const topic = ctx.body.topic ? byId.get(String(ctx.body.topic)) : null;
    if (ctx.body.topic && (!topic || !topicsFor(ctx.user.role).some((x) => x.id === topic.id))) throw badRequest('موضوع نامعتبر است');
    const text = topic ? topic.title : String(ctx.body.body ?? '').trim();
    if (!text || text.length > 2000) throw badRequest('متن پیام را بنویسید (حداکثر ۲۰۰۰ نویسه)');
    if (!topic) domain.moderate(ctx, text, 'support');
    let t = openTicketOf(ctx);
    if (!t) {
      const id = uuid();
      const ts = nowIso();
      db.run('INSERT INTO support_tickets (id, tenant_id, user_id, status, topic, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        id, ctx.tenantId, ctx.user.sub, 'bot', topic?.title ?? text.slice(0, 80), ts, ts);
      t = db.get('SELECT * FROM support_tickets WHERE id = ?', id);
    }
    add(t.id, 'user', text);
    if (topic && t.status === 'bot') {
      add(t.id, 'bot', answerOf(t.tenant_id, topic.id), { actions: [ACT.close, ACT.escalate] });
    } else if (t.status === 'bot') {
      botReply(ctx, t, text);
    } else if (t.status === 'answered') {
      // The user answered the agent: back in the team's queue.
      setStatus(t.id, 'waiting');
      for (const a of agents(t.tenant_id).filter((x) => !t.assigned_to || x.id === t.assigned_to)) {
        platform.notify(ctx, { userId: a.id, channel: 'push', target: a.phone, body: `پیام جدید در گفتگوی پشتیبانی: ${text}`.slice(0, 200) });
      }
    }
    return { status: 201, body: state(ctx) };
  });

  router.post('/v1/support/escalate', async (ctx) => {
    requireUser(ctx);
    const t = openTicketOf(ctx);
    if (!t) throw conflict('ابتدا پرسش خود را بنویسید', 'no_ticket');
    escalate(ctx, t, 'button');
    return { body: state(ctx) };
  });

  router.post('/v1/support/close', async (ctx) => {
    requireUser(ctx);
    const t = openTicketOf(ctx);
    if (t) {
      add(t.id, 'system', 'گفتگو بسته شد.');
      db.run(`UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?`, nowIso(), ctx.user.sub, nowIso(), t.id);
      platform.audit(ctx, 'support.close', `support:${t.id}`, { by: 'user' });
    }
    return { body: state(ctx) };
  });

  // ---- support desk (staff with support.handle)
  const requireAgent = (ctx) => domain.access.require(ctx, 'support.handle');
  const loadOwn = (ctx) => {
    const t = db.get('SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ? AND user_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId, ctx.user.sub);
    if (!t) throw notFound('گفتگو');
    return t;
  };
  const loadTicket = (ctx) => {
    const t = db.get('SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!t) throw notFound('گفتگو');
    return t;
  };

  // A claimed conversation is answered by the agent handling it; a supervisor (support.report) can
  // step in. Unclaimed conversations are open to every agent.
  const isSupervisor = (ctx) => domain.access.can(ctx, 'support.report');
  const canAct = (ctx, t) => !t.assigned_to || t.assigned_to === ctx.user.sub || isSupervisor(ctx);
  const requireHandler = (ctx, t) => {
    if (canAct(ctx, t)) return;
    const who = db.get('SELECT full_name FROM users WHERE id = ?', t.assigned_to)?.full_name ?? 'همکار دیگر';
    throw conflict(`این گفتگو در حال رسیدگی توسط ${who} است`, 'claimed_by_other');
  };
  const note = (t, staffId, body, kind = 'note') => db.run('INSERT INTO support_notes (id, ticket_id, staff_id, kind, body, created_at) VALUES (?,?,?,?,?,?)',
    uuid(), t.id, staffId, kind, body, nowIso());
  const nameOf = (id) => db.get('SELECT full_name, phone FROM users WHERE id = ?', id);

  router.get('/v1/support/tickets', async (ctx) => {
    requireAgent(ctx);
    // status=mine: the open conversations this agent is handling.
    const mine = ctx.query.status === 'mine';
    const status = mine ? null : ['waiting', 'answered', 'closed', 'bot'].includes(ctx.query.status) ? ctx.query.status : 'waiting';
    const rows = db.all(
      `SELECT t.*, u.full_name, u.phone, u.role, a.full_name AS assignee_name,
              (SELECT body FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_body
       FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to
       WHERE t.tenant_id = ? AND ${mine ? "t.assigned_to = ? AND t.status IN ('waiting','answered')" : 't.status = ?'}
       ORDER BY ${mine ? "CASE t.status WHEN 'waiting' THEN 0 ELSE 1 END," : ''} t.updated_at ${status === 'waiting' || mine ? 'ASC' : 'DESC'} LIMIT 100`,
      ctx.tenantId, mine ? ctx.user.sub : status,
    );
    const counts = Object.fromEntries(db.all(`SELECT status, COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? GROUP BY status`, ctx.tenantId).map((r) => [r.status, r.n]));
    counts.mine = db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? AND assigned_to = ? AND status IN ('waiting','answered')`, ctx.tenantId, ctx.user.sub).n;
    return {
      body: {
        counts,
        items: rows.map((r) => ({
          ...ticketView(r), user: { full_name: r.full_name, phone: r.phone, role: r.role }, last_body: r.last_body?.slice(0, 160) ?? null,
          assignee: r.assigned_to ? { id: r.assigned_to, full_name: r.assignee_name, me: r.assigned_to === ctx.user.sub } : null,
        })),
      },
    };
  });

  router.get('/v1/support/tickets/:id', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    platform.audit(ctx, 'support.read', `support:${t.id}`);
    const u = db.get('SELECT id, full_name, phone, role, created_at FROM users WHERE id = ?', t.user_id);
    const messages = messagesOf(t.id, { staff: true });
    // Ready-made answers for the agent, from the user's latest question.
    const lastQ = [...messages].reverse().find((m) => m.sender === 'user');
    const suggestions = lastQ ? search(u.role, lastQ.body).map((h) => ({ id: h.id, title: h.title, text: answerOf(t.tenant_id, h.id) })) : [];
    const assignee = t.assigned_to ? db.get('SELECT id, full_name FROM users WHERE id = ?', t.assigned_to) : null;
    return {
      body: {
        ...ticketView(t), user: u, messages, suggestions,
        assignee: assignee && { ...assignee, me: assignee.id === ctx.user.sub }, claimed_at: t.claimed_at,
        can_reply: canAct(ctx, t), supervisor: isSupervisor(ctx),
        notes: db.all('SELECT n.kind, n.body, n.created_at, u2.full_name AS staff_name FROM support_notes n JOIN users u2 ON u2.id = n.staff_id WHERE n.ticket_id = ? ORDER BY n.created_at, n.rowid', t.id),
        // Colleagues to hand over to, with how many open conversations each is handling.
        agents: agents(t.tenant_id).filter((a) => a.id !== ctx.user.sub).map((a) => ({
          id: a.id, full_name: db.get('SELECT full_name FROM users WHERE id = ?', a.id)?.full_name ?? a.phone,
          open: db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE assigned_to = ? AND status IN ('waiting','answered')`, a.id).n,
        })),
      },
    };
  });

  router.post('/v1/support/tickets/:id/reply', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    const text = String(ctx.body.body ?? '').trim();
    if (!text || text.length > 4000) throw badRequest('متن پاسخ را بنویسید');
    if (t.status === 'closed') throw conflict('این گفتگو بسته شده است', 'closed');
    requireHandler(ctx, t);
    domain.moderate(ctx, text, 'staff_reply', { allowLinks: true });
    add(t.id, 'staff', text, { staffId: ctx.user.sub });
    // Answering an unclaimed conversation takes it.
    // (a supervisor stepping in leaves the conversation with the agent handling it).
    db.run(`UPDATE support_tickets SET status = 'answered', assigned_to = COALESCE(assigned_to, ?), claimed_at = COALESCE(claimed_at, ?), updated_at = ? WHERE id = ?`, ctx.user.sub, nowIso(), nowIso(), t.id);
    platform.audit(ctx, 'support.reply', `support:${t.id}`);
    const u = db.get('SELECT phone FROM users WHERE id = ?', t.user_id);
    platform.notify(ctx, { userId: t.user_id, channel: 'push', target: u?.phone, body: `پاسخ پشتیبانی درمان پلاس: ${text}`.slice(0, 300) });
    return { status: 201, body: { ok: true } };
  });

  router.post('/v1/support/tickets/:id/close', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    if (t.status !== 'closed') {
      requireHandler(ctx, t);
      add(t.id, 'system', 'گفتگو توسط پشتیبانی بسته شد. اگر پرسش دیگری دارید، پیام جدید بنویسید.');
      db.run(`UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?`, nowIso(), ctx.user.sub, nowIso(), t.id);
      platform.audit(ctx, 'support.close', `support:${t.id}`, { by: 'staff' });
      if (db.get(`SELECT 1 FROM support_messages WHERE ticket_id = ? AND sender = 'staff'`, t.id)) {
        const u = db.get('SELECT phone FROM users WHERE id = ?', t.user_id);
        platform.notify(ctx, { userId: t.user_id, channel: 'push', target: u?.phone, body: 'گفتگوی پشتیبانی شما بسته شد. لطفاً از بخش «پشتیبانی» به پاسخ کارشناس امتیاز دهید.' });
      }
    }
    return { body: { ok: true } };
  });

  // «رسیدگی می‌کنم»: the agent takes the conversation; colleagues see who is on it.
  router.post('/v1/support/tickets/:id/claim', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    if (t.status === 'closed') throw conflict('این گفتگو بسته شده است', 'closed');
    if (t.assigned_to === ctx.user.sub) return { body: { ok: true } };
    requireHandler(ctx, t);
    db.run('UPDATE support_tickets SET assigned_to = ?, claimed_at = ? WHERE id = ?', ctx.user.sub, nowIso(), t.id);
    note(t, ctx.user.sub, t.assigned_to ? `رسیدگی را از ${nameOf(t.assigned_to)?.full_name ?? 'همکار'} برعهده گرفت` : 'رسیدگی را برعهده گرفت', 'claim');
    platform.audit(ctx, 'support.claim', `support:${t.id}`, { from: t.assigned_to ?? null });
    return { body: { ok: true } };
  });

  router.post('/v1/support/tickets/:id/release', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    if (!t.assigned_to) return { body: { ok: true } };
    requireHandler(ctx, t);
    db.run('UPDATE support_tickets SET assigned_to = NULL, claimed_at = NULL WHERE id = ?', t.id);
    note(t, ctx.user.sub, 'گفتگو را به صف عمومی برگرداند', 'release');
    platform.audit(ctx, 'support.release', `support:${t.id}`);
    return { body: { ok: true } };
  });

  // Hand over to a colleague (or a supervisor), with a note for them.
  router.post('/v1/support/tickets/:id/transfer', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    if (t.status === 'closed') throw conflict('این گفتگو بسته شده است', 'closed');
    requireHandler(ctx, t);
    const to = requireUuid(ctx.body.to_user_id, 'to_user_id');
    const target = agents(t.tenant_id).find((a) => a.id === to);
    if (!target) throw badRequest('این کاربر دسترسی پاسخگویی پشتیبانی ندارد', 'not_an_agent');
    const why = String(ctx.body.note ?? '').trim().slice(0, 1000);
    if (why) domain.moderate(ctx, why, 'staff_reply', { allowLinks: true });
    db.run('UPDATE support_tickets SET assigned_to = ?, claimed_at = ? WHERE id = ?', to, nowIso(), t.id);
    note(t, ctx.user.sub, `واگذار شد به ${nameOf(to)?.full_name ?? 'همکار'}${why ? ` — ${why}` : ''}`, 'transfer');
    platform.audit(ctx, 'support.transfer', `support:${t.id}`, { to });
    platform.notify(ctx, { userId: to, channel: 'push', target: target.phone, body: `گفتگوی پشتیبانی «${t.topic ?? ''}» به شما واگذار شد${why ? `: ${why}` : ''}`.slice(0, 250) });
    return { body: { ok: true } };
  });

  // Internal note: only agents see it.
  router.post('/v1/support/tickets/:id/notes', async (ctx) => {
    requireAgent(ctx);
    const t = loadTicket(ctx);
    const text = String(ctx.body.body ?? '').trim();
    if (!text || text.length > 2000) throw badRequest('متن یادداشت را بنویسید');
    domain.moderate(ctx, text, 'staff_reply', { allowLinks: true });
    note(t, ctx.user.sub, text);
    platform.audit(ctx, 'support.note', `support:${t.id}`);
    return { status: 201, body: { ok: true } };
  });

  // Delay alert: a conversation waiting longer than the set time is reported to the supervisors
  // (and to the agent handling it), then again every same period while it keeps waiting.
  function slaSweep(now = Date.now()) {
    for (const tenantId of db.all(`SELECT DISTINCT tenant_id FROM support_tickets WHERE status = 'waiting'`).map((r) => r.tenant_id)) {
      const minutes = getSupportSettings(db, tenantId).alert_minutes;
      if (!minutes) continue;
      const cutoff = new Date(now - minutes * 60000).toISOString();
      const late = db.all(
        `SELECT t.*, u.full_name FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.tenant_id = ? AND t.status = 'waiting' AND t.updated_at < ?
           AND (t.last_alert_at IS NULL OR t.last_alert_at < ?)`, tenantId, cutoff, cutoff,
      );
      if (!late.length) continue;
      const sup = db.all(`SELECT id, phone FROM users WHERE tenant_id = ? AND role IN ('admin','operator') AND deleted_at IS NULL AND disabled_at IS NULL`, tenantId)
        .filter((u) => domain.access.permissionsOf(u.id).perms.includes('support.report'));
      const ctx = { tenantId, user: null };
      for (const t of late) {
        const waited = Math.round((now - Date.parse(t.updated_at)) / 60000);
        const body = `⏰ گفتگوی پشتیبانی ${t.full_name ?? ''} («${t.topic ?? ''}») ${toFaDigits(waited)} دقیقه است بی‌پاسخ مانده${t.assigned_to ? ` (مسئول: ${nameOf(t.assigned_to)?.full_name ?? '—'})` : ' و کسی رسیدگی را برعهده نگرفته'}.`.slice(0, 250);
        const to = new Map(sup.map((u) => [u.id, u]));
        if (t.assigned_to) { const a = nameOf(t.assigned_to); to.set(t.assigned_to, { id: t.assigned_to, phone: a?.phone }); }
        for (const u of to.values()) platform.notify(ctx, { userId: u.id, channel: 'push', target: u.phone, body });
        db.run('UPDATE support_tickets SET last_alert_at = ? WHERE id = ?', new Date(now).toISOString(), t.id);
      }
    }
  }
  domain.support = { slaSweep };
  if (!config.disableSweeper) setInterval(() => { try { slaSweep(); } catch (e) { console.error('[support] sweep', e.message); } }, 60_000).unref();

  // The user rates the support team's answers (1–5 and an optional comment), once.
  router.post('/v1/support/tickets/:id/rate', async (ctx) => {
    requireUser(ctx);
    const t = loadOwn(ctx);
    const rating = Number(ctx.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('امتیاز باید بین ۱ تا ۵ باشد');
    if (t.rating != null) throw conflict('برای این گفتگو قبلاً امتیاز ثبت شده است', 'already_rated');
    // An open conversation can be rated once an agent has answered; any conversation once it is closed.
    if (t.status !== 'closed' && !db.get(`SELECT 1 FROM support_messages WHERE ticket_id = ? AND sender = 'staff'`, t.id)) {
      throw conflict('امتیاز پس از پاسخ کارشناس یا بستن گفتگو ثبت می‌شود', 'not_ready');
    }
    const comment = String(ctx.body.comment ?? '').trim().slice(0, 500) || null;
    if (comment) domain.moderate(ctx, comment, 'rating');
    db.run('UPDATE support_tickets SET rating = ?, rating_comment = ?, rated_at = ? WHERE id = ?', rating, comment, nowIso(), t.id);
    platform.audit(ctx, 'support.rate', `support:${t.id}`, { rating });
    return { body: state(ctx) };
  });
  router.post('/v1/support/tickets/:id/rate/skip', async (ctx) => {
    requireUser(ctx);
    const t = loadOwn(ctx);
    if (t.rating == null) db.run('UPDATE support_tickets SET rating = 0, rated_at = ? WHERE id = ?', nowIso(), t.id); // 0 = declined to rate
    return { body: state(ctx) };
  });

  // ---- performance report: answers, response times and satisfaction per agent
  const reportRange = (ctx) => {
    const from = ctx.query.from && !isNaN(Date.parse(ctx.query.from)) ? new Date(ctx.query.from).toISOString() : new Date(Date.now() - 30 * 864e5).toISOString();
    const to = ctx.query.to && !isNaN(Date.parse(ctx.query.to)) ? new Date(ctx.query.to).toISOString() : nowIso();
    return { from, to };
  };
  function agentStats(tenantId, { from, to }, agentId = null) {
    const rows = db.all(
      `SELECT m.staff_id, m.ticket_id, m.created_at, t.escalated_at, t.rating, t.closed_by,
              (SELECT MIN(m2.created_at) FROM support_messages m2 WHERE m2.ticket_id = t.id AND m2.sender = 'staff') AS first_staff_at,
              (SELECT m3.staff_id FROM support_messages m3 WHERE m3.ticket_id = t.id AND m3.sender = 'staff' ORDER BY m3.created_at DESC, m3.rowid DESC LIMIT 1) AS last_staff
       FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
       WHERE t.tenant_id = ? AND m.sender = 'staff' AND m.created_at >= ? AND m.created_at <= ? ${agentId ? 'AND m.staff_id = ?' : ''}`,
      tenantId, from, to, ...(agentId ? [agentId] : []),
    );
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.staff_id)) by.set(r.staff_id, { replies: 0, tickets: new Map() });
      const a = by.get(r.staff_id);
      a.replies++;
      a.tickets.set(r.ticket_id, r);
    }
    return [...by.entries()].map(([id, a]) => {
      const u = db.get('SELECT full_name, phone, role FROM users WHERE id = ?', id);
      const tickets = [...a.tickets.values()];
      // A conversation's rating counts for the agent who answered it last.
      const rated = tickets.filter((t) => t.last_staff === id && t.rating > 0);
      const firsts = tickets.filter((t) => t.escalated_at && t.first_staff_at && db.get(
        `SELECT staff_id FROM support_messages WHERE ticket_id = ? AND sender = 'staff' ORDER BY created_at, rowid LIMIT 1`, t.ticket_id,
      )?.staff_id === id).map((t) => (Date.parse(t.first_staff_at) - Date.parse(t.escalated_at)) / 60000);
      return {
        agent_id: id, full_name: u?.full_name ?? null, phone: u?.phone ?? null,
        replies: a.replies, tickets: tickets.length, closed: tickets.filter((t) => t.closed_by === id).length,
        avg_first_response_min: firsts.length ? Math.round(firsts.reduce((x, y) => x + y, 0) / firsts.length) : null,
        ratings: rated.length, avg_rating: rated.length ? Math.round((rated.reduce((x, t) => x + t.rating, 0) / rated.length) * 10) / 10 : null,
        satisfied: rated.filter((t) => t.rating >= 4).length, dissatisfied: rated.filter((t) => t.rating <= 2).length,
      };
    }).sort((x, y) => y.replies - x.replies);
  }
  const recentRatings = (tenantId, { from, to }, agentId = null) => db.all(
    `SELECT t.id, t.topic, t.rating, t.rating_comment, t.rated_at, u.full_name AS user_name,
            (SELECT s.full_name FROM support_messages m JOIN users s ON s.id = m.staff_id WHERE m.ticket_id = t.id AND m.sender = 'staff' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS agent_name,
            (SELECT m.staff_id FROM support_messages m WHERE m.ticket_id = t.id AND m.sender = 'staff' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS agent_id
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     WHERE t.tenant_id = ? AND t.rating > 0 AND t.rated_at >= ? AND t.rated_at <= ? ORDER BY t.rated_at DESC LIMIT 200`, tenantId, from, to,
  ).filter((r) => !agentId || r.agent_id === agentId);

  router.get('/v1/support/report', async (ctx) => {
    domain.access.require(ctx, 'support.report');
    const range = reportRange(ctx);
    const T = (sql, ...a) => db.get(sql, ctx.tenantId, range.from, range.to, ...a).n;
    const rated = db.get(`SELECT COUNT(*) AS n, AVG(rating) AS avg FROM support_tickets WHERE tenant_id = ? AND rating > 0 AND rated_at >= ? AND rated_at <= ?`, ctx.tenantId, range.from, range.to);
    return {
      body: {
        range,
        totals: {
          conversations: T('SELECT COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?'),
          escalated: T('SELECT COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? AND escalated_at >= ? AND escalated_at <= ?'),
          // Closed without ever reaching a person: the assistant's answer was enough.
          solved_by_assistant: T(`SELECT COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? AND status = 'closed' AND escalated_at IS NULL AND closed_at >= ? AND closed_at <= ?`),
          waiting_now: db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? AND status = 'waiting'`, ctx.tenantId).n,
          ratings: rated.n, avg_rating: rated.avg ? Math.round(rated.avg * 10) / 10 : null,
          // Conversations the assistant handled alone vs. those a support agent answered.
          ...Object.fromEntries(['assistant', 'agents'].map((k) => {
            const r = db.get(`SELECT COUNT(*) AS n, AVG(rating) AS avg FROM support_tickets t WHERE t.tenant_id = ? AND t.rating > 0 AND t.rated_at >= ? AND t.rated_at <= ?
              AND ${k === 'agents' ? '' : 'NOT '}EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id = t.id AND m.sender = 'staff')`, ctx.tenantId, range.from, range.to);
            return [`avg_rating_${k}`, r.avg ? Math.round(r.avg * 10) / 10 : null];
          })),
        },
        agents: agentStats(ctx.tenantId, range),
        ratings: recentRatings(ctx.tenantId, range),
        // Messages rejected as inappropriate, for review (and for spotting wrong rejections).
        moderation: db.all(
          `SELECT e.context, e.reason, e.excerpt, e.created_at, u.full_name, u.phone, u.role FROM moderation_events e JOIN users u ON u.id = e.user_id
           WHERE e.tenant_id = ? AND e.created_at >= ? AND e.created_at <= ? ORDER BY e.created_at DESC LIMIT 100`, ctx.tenantId, range.from, range.to,
        ),
      },
    };
  });

  // An agent's own figures and the ratings of the conversations they answered.
  router.get('/v1/support/report/me', async (ctx) => {
    requireAgent(ctx);
    const range = reportRange(ctx);
    return { body: { range, me: agentStats(ctx.tenantId, range, ctx.user.sub)[0] ?? null, ratings: recentRatings(ctx.tenantId, range, ctx.user.sub) } };
  });
}
