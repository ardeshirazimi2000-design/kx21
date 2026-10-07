import { isEditable, isLive, SOCKET_EVENTS, tallyVotes, DEFAULT_VOTE_OPTIONS, type PassRule } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { one, query, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, dateStr, param, uuid } from '../lib/validate.js';
import { emitToMeeting, emitToOfficers } from '../realtime.js';
import { meetingAccess, meetingIdOfAgendaItem, type MeetingAccess } from '../services/access.js';
import { broadcastMeeting, computeQuorum, inviteeIds, isAttending, transition } from '../services/meetings.js';
import { notify } from '../services/notifications.js';

export const agendaRouter = Router();

async function itemAccess(u: AuthUser, itemId: string, db?: Db, forUpdate = false) {
  const meetingId = await meetingIdOfAgendaItem(itemId, db);
  const a = await meetingAccess(u, meetingId, db, { forUpdate });
  const item = await one(`SELECT * FROM agenda_items WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [itemId], db);
  return { a, item };
}

async function broadcastAgenda(meetingId: string) {
  const agenda = await query(
    `SELECT id, order_no, title, status, started_at, ended_at, decision FROM agenda_items WHERE meeting_id = $1 ORDER BY order_no`,
    [meetingId],
  );
  emitToMeeting(meetingId, SOCKET_EVENTS.agendaUpdated, { meetingId, agenda });
}

// ─────────────────────────────── Agenda CRUD ───────────────────────────────

const itemSchema = z.object({
  title: z.string().min(2),
  description: z.string().nullish(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  durationMinutes: z.number().int().positive().nullish(),
  presenterId: uuid.nullish(),
  presenterName: z.string().nullish(),
  issueId: uuid.nullish(),
});

agendaRouter.post('/meetings/:id/agenda', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, itemSchema);
  const row = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isEditable(a.meeting.status) && !isLive(a.meeting.status)) throw conflict('افزودن دستور جلسه در این وضعیت مجاز نیست');
    if (b.issueId) {
      const issue = await one('SELECT commission_id FROM issues WHERE id = $1', [b.issueId], c);
      if (!issue || issue.commission_id !== a.meeting.commission_id) throw badRequest('موضوع متعلق به این کمیسیون نیست');
      await c.query(`UPDATE issues SET status = 'on_agenda', updated_at = now() WHERE id = $1`, [b.issueId]);
    }
    const r = await one(
      `INSERT INTO agenda_items (chamber_id, meeting_id, order_no, title, description, priority, duration_minutes, presenter_id, presenter_name, issue_id)
       VALUES ($1,$2,(SELECT COALESCE(max(order_no),0)+1 FROM agenda_items WHERE meeting_id = $2),$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [a.meeting.chamber_id, id, b.title, b.description ?? null, b.priority, b.durationMinutes ?? null, b.presenterId ?? null, b.presenterName ?? null, b.issueId ?? null],
      c,
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'agenda.created', entity: 'agenda_item', entityId: r.id, after: r });
    return r;
  });
  await broadcastAgenda(id);
  res.status(201).json(row);
});

agendaRouter.patch('/agenda-items/:id', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(
    req,
    itemSchema.partial().extend({
      discussionSummary: z.string().nullish(),
      decision: z.string().nullish(),
      proposedResolution: z.string().nullish(),
    }),
  );
  const row = await tx(async (c) => {
    const { a, item } = await itemAccess(u, id, c, true);
    a.require('meeting.manage');
    const s = a.meeting.status;
    const definitionChange = b.title !== undefined || b.description !== undefined || b.presenterId !== undefined || b.durationMinutes !== undefined;
    if (definitionChange && !isEditable(s) && !isLive(s)) throw conflict('ویرایش دستور جلسه در این وضعیت مجاز نیست');
    if (!isEditable(s) && !isLive(s) && s !== 'minutes_draft') throw conflict('جلسه قفل شده است');
    const r = await one(
      `UPDATE agenda_items SET title = COALESCE($2, title), description = COALESCE($3, description), priority = COALESCE($4, priority),
         duration_minutes = COALESCE($5, duration_minutes), presenter_id = COALESCE($6, presenter_id), presenter_name = COALESCE($7, presenter_name),
         discussion_summary = COALESCE($8, discussion_summary), decision = COALESCE($9, decision),
         proposed_resolution = COALESCE($10, proposed_resolution), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.title, b.description, b.priority, b.durationMinutes, b.presenterId, b.presenterName, b.discussionSummary, b.decision, b.proposedResolution],
      c,
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'agenda.updated', entity: 'agenda_item', entityId: id, before: item, after: r });
    return r;
  });
  await broadcastAgenda(row.meeting_id);
  res.json(row);
});

agendaRouter.delete('/agenda-items/:id', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ reason: z.string().optional() }));
  const meetingId = await tx(async (c) => {
    const { a, item } = await itemAccess(u, id, c, true);
    a.require('meeting.manage');
    if (item.status === 'active') throw conflict('آیتم فعال را نمی‌توان حذف کرد');
    if (!isEditable(a.meeting.status) && !isLive(a.meeting.status)) throw conflict('جلسه قفل شده است');
    await c.query(`UPDATE agenda_items SET status = 'removed', updated_at = now() WHERE id = $1`, [id]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'agenda.removed', entity: 'agenda_item', entityId: id, before: item, reason: b.reason });
    return a.meeting.id;
  });
  await broadcastAgenda(meetingId);
  res.status(204).end();
});

agendaRouter.post('/meetings/:id/agenda/reorder', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ ids: z.array(uuid).min(1) }));
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    const existing = await query<{ id: string }>('SELECT id FROM agenda_items WHERE meeting_id = $1', [id], c);
    const set = new Set(existing.map((e) => e.id));
    if (b.ids.length !== set.size || !b.ids.every((x) => set.has(x))) throw badRequest('فهرست آیتم‌ها کامل نیست');
    // two-step update to keep order_no unique-free and deterministic
    for (let i = 0; i < b.ids.length; i++) await c.query('UPDATE agenda_items SET order_no = $2 WHERE id = $1', [b.ids[i], i + 1]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'agenda.reordered', entity: 'meeting', entityId: id, after: b.ids });
  });
  await broadcastAgenda(id);
  res.status(204).end();
});

// ─────────────────────────────── Live execution ───────────────────────────────

agendaRouter.post('/meetings/:id/agenda/:itemId/activate', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const itemId = param(req, 'itemId');
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.control');
    if (!isLive(a.meeting.status)) throw conflict('جلسه هنوز شروع نشده است', 'meeting_not_live');
    const item = await one('SELECT * FROM agenda_items WHERE id = $1 AND meeting_id = $2 FOR UPDATE', [itemId, id], c);
    if (!item) throw notFound('دستور جلسه یافت نشد');
    if (item.status === 'active') return;
    if (item.status === 'removed') throw conflict('آیتم حذف‌شده قابل فعال‌سازی نیست');
    if (!a.settings.allowParallelAgenda) {
      const active = await query('SELECT id FROM agenda_items WHERE meeting_id = $1 AND status = $2', [id, 'active'], c);
      for (const act of active) {
        const openVote = await one(`SELECT 1 FROM vote_sessions WHERE agenda_item_id = $1 AND status = 'open'`, [act.id], c);
        if (openVote) throw conflict('ابتدا رأی‌گیری آیتم جاری را خاتمه دهید', 'vote_open');
        await c.query(`UPDATE agenda_items SET status = 'done', ended_at = now(), updated_at = now() WHERE id = $1`, [act.id]);
      }
    }
    await c.query(`UPDATE agenda_items SET status = 'active', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`, [itemId]);
    if (a.meeting.status === 'in_progress') await transition(c, req, a.meeting, 'begin_agenda');
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'agenda.activated', entity: 'agenda_item', entityId: itemId });
  });
  broadcastMeeting(id, { status: 'agenda_processing', activeItemId: itemId });
  await broadcastAgenda(id);
  res.status(204).end();
});

/** Close the active item with its outcome: done / referred (to an expert) / removed. */
agendaRouter.post('/agenda-items/:id/complete', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(
    req,
    z.object({
      status: z.enum(['done', 'referred', 'removed']).default('done'),
      discussionSummary: z.string().nullish(),
      decision: z.string().nullish(),
      proposedResolution: z.string().nullish(),
      referral: z.object({ expertId: uuid, request: z.string().min(3), dueDate: dateStr.nullish() }).optional(),
    }),
  );
  const { meetingId, referral } = await tx(async (c) => {
    const { a, item } = await itemAccess(u, id, c, true);
    a.require('meeting.control');
    if (!isLive(a.meeting.status)) throw conflict('جلسه در حال برگزاری نیست', 'meeting_not_live');
    const openVote = await one(`SELECT 1 FROM vote_sessions WHERE agenda_item_id = $1 AND status = 'open'`, [id], c);
    if (openVote) throw conflict('ابتدا رأی‌گیری را خاتمه دهید', 'vote_open');
    const r = await one(
      `UPDATE agenda_items SET status = $2, ended_at = now(), discussion_summary = COALESCE($3, discussion_summary),
         decision = COALESCE($4, decision), proposed_resolution = COALESCE($5, proposed_resolution), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.status, b.discussionSummary, b.decision, b.proposedResolution],
      c,
    );
    let referral = null;
    if (b.status === 'referred' && b.referral) {
      referral = await one(
        `INSERT INTO referrals (chamber_id, commission_id, issue_id, agenda_item_id, expert_id, request, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [a.meeting.chamber_id, a.meeting.commission_id, item.issue_id, id, b.referral.expertId, b.referral.request, b.referral.dueDate ?? null, u.id],
        c,
      );
      if (item.issue_id) await c.query(`UPDATE issues SET status = 'under_review', updated_at = now() WHERE id = $1`, [item.issue_id]);
    }
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: `agenda.${b.status}`, entity: 'agenda_item', entityId: id, before: item, after: r });
    return { meetingId: a.meeting.id, referral };
  });
  if (referral) {
    await notify({
      chamberId: referral.chamber_id,
      userIds: [referral.expert_id],
      event: 'referral.created',
      title: 'ارجاع کارشناسی جدید',
      body: referral.request,
      data: { referralId: referral.id },
    });
  }
  await broadcastAgenda(meetingId);
  res.status(204).end();
});

// ─────────────────────────────── Comments (اظهارنظر) ───────────────────────────────

agendaRouter.get('/agenda-items/:id/comments', async (req, res) => {
  const { item } = await itemAccess(currentUser(req), param(req, 'id'));
  res.json(
    await query(
      `SELECT cm.id, cm.body, cm.created_at, cm.user_id, u.full_name FROM comments cm JOIN users u ON u.id = cm.user_id
        WHERE cm.agenda_item_id = $1 ORDER BY cm.created_at`,
      [item.id],
    ),
  );
});

agendaRouter.post('/agenda-items/:id/comments', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ body: z.string().min(1).max(4000) }));
  const row = await tx(async (c) => {
    const { a, item } = await itemAccess(u, id, c);
    a.require('comment.create');
    if (!a.settings.allowComments) throw forbidden('ثبت نظر در این کمیسیون غیرفعال است');
    if (['cancelled', 'approved', 'archived', 'pending_approval'].includes(a.meeting.status) || item.status === 'removed') {
      throw conflict('ثبت نظر برای این آیتم بسته است');
    }
    const r = await one(
      `INSERT INTO comments (chamber_id, agenda_item_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, body, created_at, user_id`,
      [a.meeting.chamber_id, id, u.id, b.body],
      c,
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'comment.created', entity: 'comment', entityId: r.id, after: r });
    return { ...r, full_name: u.fullName, agenda_item_id: id, meeting_id: a.meeting.id };
  });
  emitToMeeting(row.meeting_id, SOCKET_EVENTS.commentCreated, row);
  res.status(201).json(row);
});

// ─────────────────────────────── Voting ───────────────────────────────

function publicResult(session: any, a: MeetingAccess) {
  return a.can('vote.results.view') ? session.result : null;
}

agendaRouter.post('/agenda-items/:id/vote/start', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(
    req,
    z.object({
      title: z.string().min(2).optional(),
      secret: z.boolean().optional(),
      options: z.array(z.string().min(1).max(40)).min(2).max(10).optional(),
      passRule: z.enum(['majority_of_present', 'majority_of_cast', 'simple_majority', 'two_thirds_of_present']).optional(),
    }),
  );
  const { session, meeting, quorum } = await tx(async (c) => {
    const { a, item } = await itemAccess(u, id, c, true);
    a.require('meeting.control');
    if (!isLive(a.meeting.status)) throw conflict('جلسه در حال برگزاری نیست', 'meeting_not_live');
    if (item.status !== 'active') throw conflict('رأی‌گیری فقط برای آیتم فعال دستور جلسه ممکن است', 'item_not_active');
    const quorum = await computeQuorum(a.meeting.id, a.settings, c);
    if (a.settings.requireQuorumForVoting && !quorum.reached) {
      throw conflict(`حد نصاب برای رأی‌گیری حاصل نیست (${quorum.present} از ${quorum.required})`, 'quorum_not_reached');
    }
    const session = await one(
      `INSERT INTO vote_sessions (chamber_id, meeting_id, agenda_item_id, title, secret, options, pass_rule, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        a.meeting.chamber_id, a.meeting.id, id, b.title ?? `رأی‌گیری: ${item.title}`, b.secret ?? a.settings.secretVoteDefault,
        JSON.stringify(b.options ?? DEFAULT_VOTE_OPTIONS), b.passRule ?? a.settings.passRule, u.id,
      ],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('برای این آیتم یک رأی‌گیری باز وجود دارد', 'vote_open');
      throw e;
    });
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'vote.opened', entity: 'vote_session', entityId: session.id, after: session });
    return { session, meeting: a.meeting, quorum };
  });
  const payload = {
    id: session.id,
    agenda_item_id: id,
    title: session.title,
    secret: session.secret,
    options: session.options,
    status: 'open',
    cast_count: 0,
    eligible: quorum.present,
  };
  emitToMeeting(meeting.id, SOCKET_EVENTS.voteOpened, payload);
  await notify({
    chamberId: meeting.chamber_id,
    userIds: await inviteeIds(meeting.id, undefined, 'voters'),
    event: 'vote.opened',
    title: 'رأی‌گیری آغاز شد',
    body: session.title,
    data: { meetingId: meeting.id, voteSessionId: session.id },
  });
  res.status(201).json(payload);
});

async function openSessionFor(itemId: string, db: Db) {
  return one(`SELECT * FROM vote_sessions WHERE agenda_item_id = $1 AND status = 'open' FOR UPDATE`, [itemId], db);
}

agendaRouter.post('/agenda-items/:id/vote', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ choice: z.string().min(1), voteSessionId: uuid.optional() }));
  const { session, cast, meetingId, eligible } = await tx(async (c) => {
    const { a } = await itemAccess(u, id, c);
    if (!a.can('vote.cast')) throw forbidden('شما حق رأی در این جلسه ندارید');
    const session = b.voteSessionId
      ? await one(`SELECT * FROM vote_sessions WHERE id = $1 AND agenda_item_id = $2 FOR UPDATE`, [b.voteSessionId, id], c)
      : await openSessionFor(id, c);
    if (!session || session.status !== 'open') throw conflict('رأی‌گیری باز نیست', 'vote_closed');
    if (!(session.options as string[]).includes(b.choice)) throw badRequest('گزینه رأی معتبر نیست');
    // A representative votes in the name of the invitee (one ballot per invitee).
    const voterId = a.delegateFor?.principalId ?? u.id;
    const att = await one('SELECT status FROM attendance WHERE meeting_id = $1 AND user_id = $2', [a.meeting.id, voterId], c);
    if (!att || !isAttending(att.status)) throw forbidden('برای رأی دادن ابتدا باید حضور شما ثبت شده باشد');
    const v = await one(
      `INSERT INTO votes (vote_session_id, voter_id, choice, cast_by) VALUES ($1,$2,$3,$4) ON CONFLICT (vote_session_id, voter_id) DO NOTHING RETURNING id, created_at`,
      [session.id, voterId, b.choice, u.id],
      c,
    );
    if (!v) throw conflict('رأی شما قبلاً ثبت شده است', 'already_voted');
    // The audit log keeps the ballot (also for secret votes); the audit API masks it for non-super-admins.
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'vote.cast',
      entity: 'vote_session',
      entityId: session.id,
      after: { choice: b.choice, secret: session.secret },
    });
    const [{ count }] = await query('SELECT count(*) FROM votes WHERE vote_session_id = $1 AND is_valid', [session.id], c);
    const q = await computeQuorum(a.meeting.id, a.settings, c);
    return { session, cast: count, meetingId: a.meeting.id, eligible: q.present };
  });
  emitToMeeting(meetingId, SOCKET_EVENTS.voteProgress, {
    voteSessionId: session.id,
    agendaItemId: id,
    castCount: cast,
    eligible,
    participationPercent: eligible ? Math.round((cast / eligible) * 1000) / 10 : 0,
  });
  res.status(201).json({ voteSessionId: session.id, choice: b.choice, castCount: cast });
});

async function closeSession(req: any, u: AuthUser, sessionId: string, reason?: string) {
  return tx(async (c) => {
    const session = await one('SELECT * FROM vote_sessions WHERE id = $1 FOR UPDATE', [sessionId], c);
    if (!session) throw notFound('رأی‌گیری یافت نشد');
    const a = await meetingAccess(u, session.meeting_id, c);
    a.require('meeting.control');
    if (session.status !== 'open') throw conflict('رأی‌گیری قبلاً بسته شده است', 'vote_closed');
    const q = await computeQuorum(a.meeting.id, a.settings, c);
    const choices = await query<{ choice: string }>('SELECT choice FROM votes WHERE vote_session_id = $1 AND is_valid', [sessionId], c);
    const tally = tallyVotes(choices.map((x) => x.choice), session.options, q.present, session.pass_rule as PassRule);
    const result = { ...tally, quorumReached: q.reached, closedAt: new Date().toISOString() };
    const closed = await one(
      `UPDATE vote_sessions SET status = 'closed', closed_by = $2, closed_at = now(), result = $3 WHERE id = $1 RETURNING *`,
      [sessionId, u.id, JSON.stringify(result)],
      c,
    );
    // Link the result to the agenda item so it flows into the minutes.
    await c.query(
      `UPDATE agenda_items SET decision = COALESCE(decision, $2), updated_at = now() WHERE id = $1`,
      [session.agenda_item_id, tally.passed ? 'تصویب شد' : 'تصویب نشد'],
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'vote.closed', entity: 'vote_session', entityId: sessionId, after: result, reason });
    return { closed, a };
  });
}

async function afterClose(closed: any, a: MeetingAccess) {
  const payload = { id: closed.id, agenda_item_id: closed.agenda_item_id, status: 'closed', result: closed.result, secret: closed.secret };
  emitToOfficers(a.meeting.id, SOCKET_EVENTS.voteClosed, payload);
  emitToMeeting(a.meeting.id, SOCKET_EVENTS.voteClosed, {
    ...payload,
    result: a.settings.resultVisibility === 'invitees' ? closed.result : null,
  });
  const recipients = a.settings.resultVisibility === 'invitees' ? await inviteeIds(a.meeting.id) : await inviteeIds(a.meeting.id, undefined, 'officers');
  await notify({
    chamberId: a.meeting.chamber_id,
    userIds: recipients,
    event: 'vote.result',
    title: 'نتیجه رأی‌گیری',
    body: closed.result.summary,
    data: { meetingId: a.meeting.id, voteSessionId: closed.id },
  });
}

agendaRouter.post('/agenda-items/:id/vote/close', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const s = await one(`SELECT id FROM vote_sessions WHERE agenda_item_id = $1 AND status = 'open'`, [id]);
  if (!s) throw conflict('رأی‌گیری باز وجود ندارد', 'vote_closed');
  const { closed, a } = await closeSession(req, u, s.id);
  await afterClose(closed, a);
  res.json({ id: closed.id, status: closed.status, result: closed.result });
});

agendaRouter.post('/vote-sessions/:id/close', async (req, res) => {
  const u = currentUser(req);
  const { closed, a } = await closeSession(req, u, param(req, 'id'));
  await afterClose(closed, a);
  res.json({ id: closed.id, status: closed.status, result: closed.result });
});

agendaRouter.get('/vote-sessions/:id', async (req, res) => {
  const u = currentUser(req);
  const session = await one('SELECT * FROM vote_sessions WHERE id = $1', [param(req, 'id')]);
  if (!session) throw notFound();
  const a = await meetingAccess(u, session.meeting_id);
  const mine = await one('SELECT choice, created_at FROM votes WHERE vote_session_id = $1 AND voter_id = $2', [session.id, a.delegateFor?.principalId ?? u.id]);
  const [{ count }] = await query('SELECT count(*) FROM votes WHERE vote_session_id = $1 AND is_valid', [session.id]);
  let voters = null;
  // Named ballots are visible for open (non-secret) votes once closed; secret votes never expose voter identity.
  if (!session.secret && session.status === 'closed' && a.can('vote.results.view')) {
    voters = await query(
      `SELECT v.voter_id, u.full_name, v.choice, v.is_valid, CASE WHEN v.cast_by <> v.voter_id THEN cb.full_name END AS cast_by_name
         FROM votes v JOIN users u ON u.id = v.voter_id LEFT JOIN users cb ON cb.id = v.cast_by
        WHERE v.vote_session_id = $1 ORDER BY u.full_name`,
      [session.id],
    );
  }
  res.json({
    id: session.id,
    agenda_item_id: session.agenda_item_id,
    title: session.title,
    secret: session.secret,
    options: session.options,
    status: session.status,
    opened_at: session.opened_at,
    closed_at: session.closed_at,
    cast_count: count,
    result: session.status === 'closed' ? publicResult(session, a) : null,
    my_choice: mine?.choice ?? null,
    voters,
  });
});

/**
 * Formal correction after a vote was closed: invalidate a ballot with a reason; the result is recomputed.
 * Restricted to the chair (minutes.approve) or chamber admins, and fully audited.
 */
agendaRouter.post('/vote-sessions/:id/corrections', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ voterId: uuid, reason: z.string().min(5, 'دلیل اصلاح الزامی است') }));
  const result = await tx(async (c) => {
    const session = await one('SELECT * FROM vote_sessions WHERE id = $1 FOR UPDATE', [id], c);
    if (!session) throw notFound();
    const a = await meetingAccess(u, session.meeting_id, c);
    if (!(a.can('minutes.approve') || a.can('commission.manage'))) throw forbidden();
    if (session.status !== 'closed') throw conflict('اصلاح فقط پس از بسته‌شدن رأی‌گیری ممکن است');
    if (['approved', 'archived'].includes(a.meeting.status)) throw conflict('صورتجلسه نهایی شده و قابل اصلاح نیست');
    const v = await one('UPDATE votes SET is_valid = false WHERE vote_session_id = $1 AND voter_id = $2 AND is_valid RETURNING id', [id, b.voterId], c);
    if (!v) throw notFound('رأی معتبر برای این فرد یافت نشد');
    const choices = await query<{ choice: string }>('SELECT choice FROM votes WHERE vote_session_id = $1 AND is_valid', [id], c);
    const eligible = session.result?.eligiblePresent ?? 0;
    const tally = tallyVotes(choices.map((x) => x.choice), session.options, eligible, session.pass_rule as PassRule);
    const result = { ...session.result, ...tally, corrected: true };
    await c.query('UPDATE vote_sessions SET result = $2 WHERE id = $1', [id, JSON.stringify(result)]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'vote.corrected', entity: 'vote_session', entityId: id, before: session.result, after: result, reason: b.reason });
    return result;
  });
  res.json(result);
});
