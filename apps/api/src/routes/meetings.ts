import {
  ATTENDANCE_STATUSES,
  availableActions,
  formatJalaliDateTime,
  isCheckinWindow,
  isEditable,
  isLive,
  MEETING_TYPES,
  type AttendanceStatus,
} from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, paged, pageParams, param, uuid } from '../lib/validate.js';
import { commissionAccess, meetingAccess, type MeetingAccess } from '../services/access.js';
import {
  broadcastAttendance,
  broadcastMeeting,
  computeQuorum,
  ensureAttendanceRows,
  inviteeIds,
  loadAttendance,
  quorumOf,
  quorumSummary,
  transition,
} from '../services/meetings.js';
import { generateMinutesDraft } from '../services/minutes.js';
import { listDelegates } from './delegates.js';
import { adminBrowsableChambers, assertRole, browsableCommissionIds, defaultHasVote } from '../services/roles.js';
import { notify } from '../services/notifications.js';

export const meetingsRouter = Router();

// ─────────────────────────────── List / calendar ───────────────────────────────

meetingsRouter.get('/meetings', async (req, res) => {
  const u = currentUser(req);
  const { page, pageSize, offset, q } = pageParams(req);
  const commissionId = req.query.commissionId ? uuid.parse(req.query.commissionId) : null;
  const from = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
  const to = typeof req.query.to === 'string' ? new Date(req.query.to) : null;
  const status = typeof req.query.status === 'string' ? req.query.status.split(',') : null;
  const mine = req.query.mine === 'true';
  const where = `($1::uuid IS NULL OR m.commission_id = $1)
    AND ($2::timestamptz IS NULL OR m.scheduled_at >= $2) AND ($3::timestamptz IS NULL OR m.scheduled_at < $3)
    AND ($4::text[] IS NULL OR m.status = ANY($4))
    AND ($5::text IS NULL OR m.title ILIKE '%' || $5 || '%' OR c.name ILIKE '%' || $5 || '%')
    AND (
      EXISTS (SELECT 1 FROM meeting_invitees i WHERE i.meeting_id = m.id AND i.user_id = $6)
      OR EXISTS (SELECT 1 FROM meeting_delegates d WHERE d.meeting_id = m.id AND d.delegate_id = $6 AND d.status = 'active')
      OR (NOT $9 AND (
        $7::boolean OR m.chamber_id = ANY($8::uuid[]) OR m.commission_id = ANY($10::uuid[])))
    )`;
  const [browse, adminBrowse] = await Promise.all([browsableCommissionIds(u), adminBrowsableChambers(u)]);
  const params = [commissionId, from, to, status, q, u.id, u.isSuperAdmin, adminBrowse, mine, browse];
  const items = await query(
    `SELECT m.id, m.commission_id, c.name AS commission_name, m.number, m.title, m.scheduled_at, m.duration_minutes,
            m.location, m.online_link, m.type, m.status, ch.name AS chamber_name,
            COALESCE(i.role, CASE WHEN dl.id IS NOT NULL THEN 'delegate' END) AS my_role, COALESCE(a.status, pa.status) AS my_attendance
       FROM meetings m JOIN commissions c ON c.id = m.commission_id JOIN chambers ch ON ch.id = m.chamber_id
       LEFT JOIN meeting_invitees i ON i.meeting_id = m.id AND i.user_id = $6
       LEFT JOIN attendance a ON a.meeting_id = m.id AND a.user_id = $6
       LEFT JOIN meeting_delegates dl ON dl.meeting_id = m.id AND dl.delegate_id = $6 AND dl.status = 'active'
       LEFT JOIN attendance pa ON pa.meeting_id = m.id AND pa.user_id = dl.principal_id
      WHERE ${where}
      ORDER BY m.scheduled_at ${req.query.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM meetings m JOIN commissions c ON c.id = m.commission_id WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

// ─────────────────────────────── Create / read / update ───────────────────────────────

const agendaInput = z.object({
  title: z.string().min(2),
  description: z.string().nullish(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  durationMinutes: z.number().int().positive().nullish(),
  presenterId: uuid.nullish(),
  presenterName: z.string().nullish(),
  issueId: uuid.nullish(),
});

const meetingSchema = z.object({
  commissionId: uuid,
  number: z.number().int().positive().optional(),
  title: z.string().min(2),
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(10).max(600).default(90),
  location: z.string().nullish(),
  onlineLink: z.string().url().nullish(),
  type: z.enum(MEETING_TYPES).default('in_person'),
  inviteAllMembers: z.boolean().default(true),
  invitees: z.array(z.object({ userId: uuid, role: z.string().default('guest'), hasVote: z.boolean().optional() })).default([]),
  agenda: z.array(agendaInput).default([]),
  schedule: z.boolean().default(false),
});

meetingsRouter.post('/meetings', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, meetingSchema);
  const ca = await commissionAccess(u, b.commissionId);
  ca.require('meeting.manage');
  if (ca.commission.status !== 'active') throw conflict('کمیسیون فعال نیست');
  const row = await tx(async (c) => {
    await c.query('SELECT 1 FROM commissions WHERE id = $1 FOR UPDATE', [b.commissionId]);
    const number =
      b.number ?? ((await one<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM meetings WHERE commission_id = $1', [b.commissionId], c))!.n);
    const m = await one(
      `INSERT INTO meetings (chamber_id, commission_id, number, title, scheduled_at, duration_minutes, location, online_link, type, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ca.commission.chamber_id, b.commissionId, number, b.title, b.scheduledAt, b.durationMinutes,
        b.location ?? null, b.onlineLink ?? null, b.type, b.schedule ? 'scheduled' : 'draft', u.id,
      ],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('شماره جلسه در این کمیسیون تکراری است');
      throw e;
    });
    if (b.inviteAllMembers) {
      await c.query(
        `INSERT INTO meeting_invitees (meeting_id, user_id, role, has_vote)
         SELECT $1, user_id, position, has_vote FROM commission_memberships
          WHERE commission_id = $2 AND status = 'active' AND position <> 'expert'
         ON CONFLICT DO NOTHING`,
        [m.id, b.commissionId],
      );
    }
    for (const inv of b.invitees) {
      await assertRole(m.chamber_id, inv.role, 'meeting', c);
      await c.query(
        `INSERT INTO meeting_invitees (meeting_id, user_id, role, has_vote) VALUES ($1,$2,$3,$4)
         ON CONFLICT (meeting_id, user_id) DO UPDATE SET role = EXCLUDED.role, has_vote = EXCLUDED.has_vote`,
        [m.id, inv.userId, inv.role, inv.hasVote ?? (await defaultHasVote(m.chamber_id, inv.role, c))],
      );
    }
    let order = 1;
    for (const a of b.agenda) {
      await c.query(
        `INSERT INTO agenda_items (chamber_id, meeting_id, order_no, title, description, priority, duration_minutes, presenter_id, presenter_name, issue_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [m.chamber_id, m.id, order++, a.title, a.description ?? null, a.priority, a.durationMinutes ?? null, a.presenterId ?? null, a.presenterName ?? null, a.issueId ?? null],
      );
      if (a.issueId) await c.query(`UPDATE issues SET status = 'on_agenda', updated_at = now() WHERE id = $1 AND commission_id = $2`, [a.issueId, b.commissionId]);
    }
    await audit(c, req, { chamberId: m.chamber_id, action: 'meeting.created', entity: 'meeting', entityId: m.id, after: m });
    return m;
  });
  res.status(201).json(row);
});

export async function meetingDetail(a: MeetingAccess, userId: string) {
  const m = a.meeting;
  const [agenda, attendance, votes, minutes, docs] = await Promise.all([
    query(
      `SELECT ai.*, u.full_name AS presenter_full_name,
         (SELECT count(*) FROM comments cm WHERE cm.agenda_item_id = ai.id) AS comment_count
         FROM agenda_items ai LEFT JOIN users u ON u.id = ai.presenter_id
        WHERE ai.meeting_id = $1 ORDER BY ai.order_no`,
      [m.id],
    ),
    loadAttendance(m.id),
    query(
      `SELECT vs.id, vs.agenda_item_id, vs.title, vs.secret, vs.options, vs.status, vs.opened_at, vs.closed_at,
              CASE WHEN vs.status = 'closed' AND $3 THEN vs.result END AS result,
              (SELECT count(*) FROM votes v WHERE v.vote_session_id = vs.id AND v.is_valid) AS cast_count,
              (SELECT v.choice FROM votes v WHERE v.vote_session_id = vs.id AND v.voter_id = $2) AS my_choice
         FROM vote_sessions vs WHERE vs.meeting_id = $1 ORDER BY vs.opened_at`,
      [m.id, a.delegateFor?.principalId ?? userId, a.can('vote.results.view')],
    ),
    one('SELECT id, status, version, minutes_number, approved_at FROM minutes WHERE meeting_id = $1', [m.id]),
    query(
      `SELECT id, agenda_item_id, kind, title, file_name, mime_type, size_bytes, created_at FROM documents
        WHERE meeting_id = $1 OR agenda_item_id IN (SELECT id FROM agenda_items WHERE meeting_id = $1) ORDER BY created_at`,
      [m.id],
    ),
  ]);
  const q = quorumOf(attendance, a.settings);
  const me = attendance.find((r) => r.user_id === (a.delegateFor?.principalId ?? userId)) ?? null;
  const allDelegates = await listDelegates(m.id);
  // Officers see every representative; an invitee sees their own.
  const delegates = a.can('attendance.view_all') ? allDelegates : allDelegates.filter((d: any) => d.principal_id === userId);
  return {
    ...m,
    delegates,
    commission: { id: a.commission.id, name: a.commission.name, code: a.commission.code },
    settings: a.settings,
    capabilities: [...a.caps],
    availableActions: a.can('meeting.manage') || a.can('meeting.control') ? availableActions(m.status) : [],
    checkinOpen: isCheckinWindow(m.status) && !m.checkin_closed_at,
    my: { role: a.inviteeRole, hasVote: a.hasVote, attendance: me, delegateFor: a.delegateFor },
    // Members see the invited list; the live status of each person is for officers.
    invitees: a.can('attendance.view_all')
      ? attendance
      : attendance.map((r) => ({ user_id: r.user_id, full_name: r.full_name, organization: r.organization, role: r.role, role_title: r.role_title })),
    quorum: a.can('attendance.view_all') ? q : quorumSummary(q),
    agenda,
    votes,
    minutes,
    documents: docs,
  };
}

meetingsRouter.get('/meetings/:id', async (req, res) => {
  const u = currentUser(req);
  const a = await meetingAccess(u, param(req, 'id'));
  res.json(await meetingDetail(a, u.id));
});

meetingsRouter.patch('/meetings/:id', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, meetingSchema.pick({ title: true, scheduledAt: true, durationMinutes: true, location: true, onlineLink: true, type: true }).partial());
  const { after, changed, notifyChange } = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isEditable(a.meeting.status)) throw conflict('جلسه در وضعیت فعلی قابل ویرایش نیست');
    const before = a.meeting;
    const after = await one(
      `UPDATE meetings SET title = COALESCE($2, title), scheduled_at = COALESCE($3, scheduled_at), duration_minutes = COALESCE($4, duration_minutes),
         location = COALESCE($5, location), online_link = COALESCE($6, online_link), type = COALESCE($7, type), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.title, b.scheduledAt, b.durationMinutes, b.location, b.onlineLink, b.type],
      c,
    );
    const changed =
      new Date(before.scheduled_at).getTime() !== new Date(after.scheduled_at).getTime() ||
      before.location !== after.location ||
      before.online_link !== after.online_link ||
      before.type !== after.type;
    await audit(c, req, { chamberId: before.chamber_id, action: 'meeting.updated', entity: 'meeting', entityId: id, before, after });
    return { after, changed, notifyChange: before.status !== 'draft' && before.status !== 'scheduled' };
  });
  if (changed && notifyChange) {
    await notify({
      chamberId: after.chamber_id,
      userIds: await inviteeIds(id),
      event: 'meeting.changed',
      title: `تغییر جلسه: ${after.title}`,
      body: `زمان/مکان جلسه تغییر کرد: ${formatJalaliDateTime(after.scheduled_at)}${after.location ? ` — ${after.location}` : ''}`,
      data: { meetingId: id },
    });
  }
  broadcastMeeting(id, { changed: true });
  res.json(after);
});

// ─────────────────────────────── Invitees ───────────────────────────────

meetingsRouter.post('/meetings/:id/invitees', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ userId: uuid, role: z.string().default('guest'), hasVote: z.boolean().optional() }));
  const sendNow = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isEditable(a.meeting.status) && !isLive(a.meeting.status)) throw conflict('امکان افزودن مدعو در این وضعیت وجود ندارد');
    const person = await one('SELECT chamber_id FROM users WHERE id = $1 AND is_active', [b.userId], c);
    if (!person || person.chamber_id !== a.meeting.chamber_id) throw badRequest('فرد متعلق به این اتاق نیست');
    await assertRole(a.meeting.chamber_id, b.role, 'meeting', c);
    const hasVote = b.hasVote ?? (await defaultHasVote(a.meeting.chamber_id, b.role, c));
    await c.query(
      `INSERT INTO meeting_invitees (meeting_id, user_id, role, has_vote, invited_at) VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() END)
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET role = EXCLUDED.role, has_vote = EXCLUDED.has_vote`,
      [id, b.userId, b.role, hasVote, a.meeting.status !== 'draft' && a.meeting.status !== 'scheduled'],
    );
    const sent = a.meeting.status !== 'draft' && a.meeting.status !== 'scheduled';
    if (sent) await ensureAttendanceRows(id, c);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'meeting.invitee_added', entity: 'meeting', entityId: id, after: { ...b, hasVote } });
    return sent ? a.meeting : null;
  });
  if (sendNow) {
    await notify({
      chamberId: sendNow.chamber_id,
      userIds: [b.userId],
      event: 'meeting.invited',
      title: `دعوت به جلسه: ${sendNow.title}`,
      body: `${formatJalaliDateTime(sendNow.scheduled_at)}${sendNow.location ? ` — ${sendNow.location}` : ''}`,
      data: { meetingId: id },
    });
    const a = await meetingAccess(u, id);
    await broadcastAttendance(id, a.settings);
  }
  res.status(204).end();
});

meetingsRouter.delete('/meetings/:id/invitees/:userId', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const userId = param(req, 'userId');
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isEditable(a.meeting.status)) throw conflict('حذف مدعو فقط پیش از شروع جلسه ممکن است');
    await c.query('DELETE FROM attendance WHERE meeting_id = $1 AND user_id = $2', [id, userId]);
    await c.query('DELETE FROM meeting_invitees WHERE meeting_id = $1 AND user_id = $2', [id, userId]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'meeting.invitee_removed', entity: 'meeting', entityId: id, before: { userId } });
  });
  res.status(204).end();
});

// ─────────────────────────────── Lifecycle ───────────────────────────────

meetingsRouter.post('/meetings/:id/schedule', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    await transition(c, req, a.meeting, 'schedule');
  });
  broadcastMeeting(id, { status: 'scheduled' });
  res.json(await meetingDetail(await meetingAccess(u, id), u.id));
});

meetingsRouter.post('/meetings/:id/invite', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const { meeting, newInvitees } = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (a.meeting.status === 'draft') await transition(c, req, a.meeting, 'schedule');
    if (a.meeting.status !== 'checkin_open') await transition(c, req, a.meeting, 'send_invitations');
    const fresh = await query<{ user_id: string }>(
      'UPDATE meeting_invitees SET invited_at = now() WHERE meeting_id = $1 AND invited_at IS NULL RETURNING user_id',
      [id],
      c,
    );
    await ensureAttendanceRows(id, c);
    return { meeting: a.meeting, newInvitees: fresh.map((r) => r.user_id) };
  });
  await notify({
    chamberId: meeting.chamber_id,
    userIds: newInvitees,
    event: 'meeting.invited',
    title: `دعوت به جلسه: ${meeting.title}`,
    body: `${formatJalaliDateTime(meeting.scheduled_at)}${meeting.location ? ` — ${meeting.location}` : ''}`,
    data: { meetingId: id },
  });
  broadcastMeeting(id, { status: meeting.status });
  res.json({ invited: newInvitees.length });
});

meetingsRouter.post('/meetings/:id/checkin/open', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const meeting = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (a.meeting.status === 'draft') await transition(c, req, a.meeting, 'schedule');
    await transition(c, req, a.meeting, 'open_checkin', { set: 'checkin_closed_at = NULL' });
    await ensureAttendanceRows(id, c);
    return a.meeting;
  });
  await notify({
    chamberId: meeting.chamber_id,
    userIds: await inviteeIds(id),
    event: 'meeting.checkin_opened',
    title: `اعلام حضور باز شد: ${meeting.title}`,
    body: 'لطفاً از طریق اپلیکیشن حضور خود را اعلام کنید.',
    data: { meetingId: id },
  });
  broadcastMeeting(id, { status: meeting.status, checkinOpen: true });
  res.json({ status: meeting.status });
});

meetingsRouter.post('/meetings/:id/checkin/close', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isCheckinWindow(a.meeting.status)) throw conflict('اعلام حضور در این وضعیت باز نیست');
    await c.query('UPDATE meetings SET checkin_closed_at = now() WHERE id = $1', [id]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'meeting.checkin_closed', entity: 'meeting', entityId: id });
  });
  broadcastMeeting(id, { checkinOpen: false });
  res.status(204).end();
});

meetingsRouter.post('/meetings/:id/start', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const { meeting, quorum, settings } = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.control');
    await ensureAttendanceRows(id, c);
    const quorum = await computeQuorum(id, a.settings, c);
    if (a.settings.requireQuorumToStart && !quorum.reached) {
      throw conflict(`حد نصاب حاصل نشده است (${quorum.present} از ${quorum.required})`, 'quorum_not_reached');
    }
    await transition(c, req, a.meeting, 'start', { set: 'started_at = now(), started_by = $3', params: [u.id] });
    return { meeting: a.meeting, quorum, settings: a.settings };
  });
  if (!quorum.reached) {
    await notify({
      chamberId: meeting.chamber_id,
      userIds: await inviteeIds(id, undefined, 'officers'),
      event: 'meeting.quorum_not_reached',
      title: `عدم حد نصاب: ${meeting.title}`,
      body: `حاضرین ${quorum.present} نفر؛ حد نصاب ${quorum.required} نفر.`,
      data: { meetingId: id },
    });
  }
  broadcastMeeting(id, { status: meeting.status, startedAt: new Date() });
  await broadcastAttendance(id, settings);
  res.json(await meetingDetail(await meetingAccess(u, id), u.id));
});

meetingsRouter.post('/meetings/:id/end', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const settings = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.control');
    const open = await one(`SELECT 1 FROM vote_sessions WHERE meeting_id = $1 AND status = 'open'`, [id], c);
    if (open) throw conflict('ابتدا رأی‌گیری باز را خاتمه دهید', 'vote_open');
    await c.query(`UPDATE agenda_items SET status = 'done', ended_at = now(), updated_at = now() WHERE meeting_id = $1 AND status = 'active'`, [id]);
    // Invitees who never checked in are recorded as absent.
    await c.query(`UPDATE attendance SET status = 'absent', updated_at = now() WHERE meeting_id = $1 AND status = 'pending'`, [id]);
    await transition(c, req, a.meeting, 'end', {
      set: 'ended_at = now(), ended_by = $3, checkin_closed_at = COALESCE(checkin_closed_at, now())',
      params: [u.id],
    });
    await generateMinutesDraft(c, req, id);
    return a.settings;
  });
  broadcastMeeting(id, { status: 'minutes_draft', endedAt: new Date() });
  await broadcastAttendance(id, settings);
  res.json(await meetingDetail(await meetingAccess(u, id), u.id));
});

meetingsRouter.post('/meetings/:id/cancel', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ reason: z.string().min(3, 'دلیل لغو الزامی است') }));
  const meeting = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    await transition(c, req, a.meeting, 'cancel', { set: 'cancel_reason = $3', params: [b.reason], reason: b.reason });
    return a.meeting;
  });
  await notify({
    chamberId: meeting.chamber_id,
    userIds: await inviteeIds(id),
    event: 'meeting.cancelled',
    title: `لغو جلسه: ${meeting.title}`,
    body: `دلیل: ${b.reason}`,
    data: { meetingId: id },
  });
  broadcastMeeting(id, { status: 'cancelled' });
  res.status(204).end();
});

meetingsRouter.post('/meetings/:id/archive', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    await transition(c, req, a.meeting, 'archive');
  });
  res.status(204).end();
});

// ─────────────────────────────── Attendance (اعلام حضور) ───────────────────────────────

meetingsRouter.post('/meetings/:id/check-in', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ method: z.enum(['app', 'web', 'online']).default('app'), proxyName: z.string().min(3).optional() }));
  const { row, settings, created } = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('attendance.self');
    if (!isCheckinWindow(a.meeting.status)) throw conflict('اعلام حضور برای این جلسه باز نیست', 'checkin_closed');
    if (a.meeting.checkin_closed_at) throw conflict('مهلت اعلام حضور به پایان رسیده است؛ با دبیر هماهنگ کنید', 'checkin_closed');
    if (b.proxyName && !a.settings.allowProxy) throw forbidden('حضور نماینده در این کمیسیون مجاز نیست');
    // A representative checks in on the invitee's attendance row (status «proxy»).
    const forUser = a.delegateFor?.principalId ?? u.id;
    const proxyName = a.delegateFor ? u.fullName : (b.proxyName ?? null);
    const existing = await one('SELECT * FROM attendance WHERE meeting_id = $1 AND user_id = $2 FOR UPDATE', [id, forUser], c);
    const status: AttendanceStatus = proxyName ? 'proxy' : b.method === 'online' ? 'online' : 'present';
    // Idempotent: a repeated check-in keeps the original timestamp and creates no new record.
    if (existing && existing.status === status && existing.checked_in_at) return { row: existing, settings: a.settings, created: false };
    const row = await one(
      `INSERT INTO attendance (meeting_id, user_id, status, method, checked_in_at, proxy_name, proxy_user_id, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,now())
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = EXCLUDED.status, method = EXCLUDED.method,
         checked_in_at = COALESCE(attendance.checked_in_at, EXCLUDED.checked_in_at), proxy_name = EXCLUDED.proxy_name,
         proxy_user_id = EXCLUDED.proxy_user_id, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [id, forUser, status, b.method, proxyName, a.delegateFor ? u.id : null, u.id],
      c,
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'attendance.check_in', entity: 'attendance', entityId: `${id}:${forUser}`, before: existing, after: row });
    return { row, settings: a.settings, created: true };
  });
  if (created) await broadcastAttendance(id, settings);
  res.status(created ? 201 : 200).json(row);
});

meetingsRouter.get('/meetings/:id/attendance', async (req, res) => {
  const u = currentUser(req);
  const a = await meetingAccess(u, param(req, 'id'));
  const rows = await loadAttendance(a.meeting.id);
  const q = quorumOf(rows, a.settings);
  if (a.can('attendance.view_all')) {
    res.json({ attendance: rows, quorum: q });
    return;
  }
  const meId = a.delegateFor?.principalId ?? u.id;
  res.json({ me: rows.find((r) => r.user_id === meId) ?? null, quorum: quorumSummary(q) });
});

/** Secretary/chair records or corrects someone's attendance. A reason is mandatory and the change is audited. */
meetingsRouter.post('/meetings/:id/attendance/:memberId/confirm', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const memberId = param(req, 'memberId');
  const b = body(
    req,
    z.object({
      status: z.enum(ATTENDANCE_STATUSES).default('manual_present'),
      reason: z.string().min(2, 'ثبت دلیل اصلاح الزامی است'),
      proxyName: z.string().optional(),
    }),
  );
  const { row, settings } = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (['draft', 'cancelled', 'approved', 'archived', 'pending_approval'].includes(a.meeting.status)) {
      throw conflict('اصلاح حضور در این وضعیت جلسه مجاز نیست');
    }
    const inv = await one('SELECT 1 FROM meeting_invitees WHERE meeting_id = $1 AND user_id = $2', [id, memberId], c);
    if (!inv) throw notFound('این فرد به جلسه دعوت نشده است');
    if (b.status === 'proxy' && !a.settings.allowProxy) throw forbidden('حضور نماینده در این کمیسیون مجاز نیست');
    const before = await one('SELECT * FROM attendance WHERE meeting_id = $1 AND user_id = $2 FOR UPDATE', [id, memberId], c);
    const attending = ['present', 'online', 'proxy', 'manual_present'].includes(b.status);
    const row = await one(
      `INSERT INTO attendance (meeting_id, user_id, status, method, checked_in_at, proxy_name, note, updated_by, updated_at)
       VALUES ($1,$2,$3,'manual', CASE WHEN $7 THEN now() END, $4, $5, $6, now())
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = EXCLUDED.status, method = 'manual',
         checked_in_at = CASE WHEN $7 THEN COALESCE(attendance.checked_in_at, now()) ELSE attendance.checked_in_at END,
         proxy_name = EXCLUDED.proxy_name, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [id, memberId, b.status, b.proxyName ?? null, b.reason, u.id, attending],
      c,
    );
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'attendance.corrected',
      entity: 'attendance',
      entityId: `${id}:${memberId}`,
      before,
      after: row,
      reason: b.reason,
    });
    return { row, settings: a.settings };
  });
  await broadcastAttendance(id, settings);
  res.json(row);
});

meetingsRouter.get('/meetings/:id/quorum', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  const q = await computeQuorum(a.meeting.id, a.settings);
  res.json(a.can('attendance.view_all') ? q : quorumSummary(q));
});

/** Calendar file for "add to my calendar". */
meetingsRouter.get('/meetings/:id/ics', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  const m = a.meeting;
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(m.scheduled_at);
  const end = new Date(start.getTime() + m.duration_minutes * 60000);
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KX//Commissions//FA',
    'BEGIN:VEVENT',
    `UID:${m.id}@kx`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(`${a.commission.name} — جلسه ${m.number}: ${m.title}`)}`,
    m.location ? `LOCATION:${esc(m.location)}` : '',
    m.online_link ? `URL:${m.online_link}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
  res.setHeader('content-type', 'text/calendar; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="meeting-${m.number}.ics"`);
  res.send(ics);
});
