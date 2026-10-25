import crypto from 'node:crypto';
import { toJalali } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, pool, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { body, param } from '../lib/validate.js';
import { isChamberAdmin, meetingAccess } from '../services/access.js';
import { broadcastMeeting, inviteeIds, transition } from '../services/meetings.js';
import { attendanceInSync, generateMinutesDraft, syncMinutesAttendance } from '../services/minutes.js';
import { notify } from '../services/notifications.js';

export const minutesRouter = Router();

minutesRouter.get('/meetings/:id/minutes', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  a.require('minutes.view');
  const m = await one('SELECT * FROM minutes WHERE meeting_id = $1', [a.meeting.id]);
  if (!m) throw notFound('صورتجلسه هنوز ایجاد نشده است');
  // Drafts are internal to the officers (and the chamber admin, who may reopen approved ones) until approved.
  const admin = isChamberAdmin(currentUser(req), a.meeting.chamber_id);
  if (m.status !== 'approved' && !a.can('meeting.manage') && !a.can('minutes.approve') && !admin) throw notFound('صورتجلسه هنوز نهایی نشده است');
  const versions = a.can('meeting.manage')
    ? await query(
        `SELECT v.version, v.created_at, u.full_name AS edited_by FROM minutes_versions v LEFT JOIN users u ON u.id = v.edited_by
          WHERE v.minutes_id = $1 ORDER BY v.version DESC`,
        [m.id],
      )
    : [];
  // Whether the text still shows the recorded attendance (null: the section was rewritten by hand).
  const attendanceSynced = a.can('meeting.manage') && a.meeting.status === 'minutes_draft' ? await attendanceInSync(pool, a.meeting.id, m.body) : true;
  const canReopen = ['approved', 'archived'].includes(a.meeting.status) && admin;
  res.json({ ...m, versions, attendanceSynced, canReopen, capabilities: [...a.caps] });
});

/** Brings the attendance section of the draft up to date with the recorded attendance. */
minutesRouter.post('/meetings/:id/minutes/sync-attendance', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const result = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (a.meeting.status !== 'minutes_draft') throw conflict('صورتجلسه فقط در وضعیت پیش‌نویس قابل ویرایش است', 'minutes_locked');
    const r = await syncMinutesAttendance(c, req, id);
    if (r === 'manual') throw conflict('بخش «حاضرین و غایبین» در متن صورتجلسه پیدا نشد؛ آن را دستی اصلاح کنید یا صورتجلسه را از داده‌ها دوباره تولید کنید', 'attendance_section_missing');
    return r;
  });
  res.json({ result });
});

/** Save an edited draft (creates a new version). */
minutesRouter.post('/meetings/:id/minutes', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ body: z.string().min(10).optional(), regenerate: z.boolean().default(false) }));
  const row = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (a.meeting.status !== 'minutes_draft') throw conflict('صورتجلسه فقط در وضعیت پیش‌نویس قابل ویرایش است', 'minutes_locked');
    if (b.regenerate || !b.body) return generateMinutesDraft(c, req, id);
    const m = await one('SELECT * FROM minutes WHERE meeting_id = $1 FOR UPDATE', [id], c);
    if (!m) throw notFound();
    const r = await one(
      `UPDATE minutes SET body = $2, version = version + 1, status = 'draft', updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id, b.body],
      c,
    );
    await c.query('INSERT INTO minutes_versions (minutes_id, version, body, edited_by) VALUES ($1,$2,$3,$4)', [r.id, r.version, r.body, u.id]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'minutes.edited', entity: 'minutes', entityId: r.id, after: { version: r.version } });
    return r;
  });
  res.json(row);
});

async function minutesAndAccess(u: any, minutesId: string, c: any) {
  const m = await one('SELECT * FROM minutes WHERE id = $1 FOR UPDATE', [minutesId], c);
  if (!m) throw notFound('صورتجلسه یافت نشد');
  const a = await meetingAccess(u, m.meeting_id, c, { forUpdate: true });
  return { m, a };
}

minutesRouter.post('/minutes/:id/submit', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ ignoreAttendanceMismatch: z.boolean().default(false) }));
  const { meeting } = await tx(async (c) => {
    const { m, a } = await minutesAndAccess(u, param(req, 'id'), c);
    a.require('meeting.manage');
    if (a.meeting.archival) throw conflict('صورتجلسهٔ جلسهٔ سوابق با «نهایی‌سازی» ثبت می‌شود، نه ارسال برای تأیید', 'archival');
    if (!b.ignoreAttendanceMismatch && a.meeting.status === 'minutes_draft' && (await attendanceInSync(c, a.meeting.id, m.body)) !== true) {
      throw conflict('بخش «حاضرین و غایبین» صورتجلسه با حضور و غیاب ثبت‌شده یکسان نیست', 'attendance_mismatch');
    }
    await transition(c, req, a.meeting, 'submit_minutes');
    await c.query(`UPDATE minutes SET status = 'pending_approval', submitted_at = now(), return_reason = NULL WHERE id = $1`, [m.id]);
    return { meeting: a.meeting };
  });
  const chairs = await query<{ user_id: string }>(
    `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position IN ('chair')`,
    [meeting.commission_id],
  );
  await notify({
    chamberId: meeting.chamber_id,
    userIds: chairs.map((x) => x.user_id),
    event: 'minutes.pending_approval',
    title: 'صورتجلسه در انتظار تأیید',
    body: `صورتجلسه «${meeting.title}» برای تأیید ارسال شد.`,
    data: { meetingId: meeting.id },
  });
  broadcastMeeting(meeting.id, { status: meeting.status });
  res.status(204).end();
});

minutesRouter.post('/minutes/:id/return', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ reason: z.string().min(3, 'دلیل برگشت الزامی است') }));
  const { meeting } = await tx(async (c) => {
    const { m, a } = await minutesAndAccess(u, param(req, 'id'), c);
    a.require('minutes.approve');
    await transition(c, req, a.meeting, 'return_minutes', { reason: b.reason });
    await c.query(`UPDATE minutes SET status = 'returned', return_reason = $2 WHERE id = $1`, [m.id, b.reason]);
    return { meeting: a.meeting };
  });
  await notify({
    chamberId: meeting.chamber_id,
    userIds: await inviteeIds(meeting.id, undefined, 'officers'),
    event: 'minutes.returned',
    title: 'صورتجلسه برای اصلاح برگشت داده شد',
    body: b.reason,
    data: { meetingId: meeting.id },
  });
  broadcastMeeting(meeting.id, { status: meeting.status });
  res.status(204).end();
});

/** Chair approval locks the minutes: final number, version and content hash are recorded. */
minutesRouter.post('/minutes/:id/approve', async (req, res) => {
  const u = currentUser(req);
  const { meeting, row } = await tx(async (c) => {
    const { m, a } = await minutesAndAccess(u, param(req, 'id'), c);
    a.require('minutes.approve');
    await transition(c, req, a.meeting, 'approve_minutes');
    const d = new Date(a.meeting.scheduled_at);
    const [jy] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const number = `${a.commission.code}/${jy}/${a.meeting.number}`;
    const hash = crypto.createHash('sha256').update(m.body).digest('hex');
    const row = await one(
      `UPDATE minutes SET status = 'approved', approved_by = $2, approved_at = now(), minutes_number = $3, content_hash = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [m.id, u.id, number, hash],
      c,
    );
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'minutes.approved',
      entity: 'minutes',
      entityId: m.id,
      after: { number, version: m.version, contentHash: hash },
    });
    return { meeting: a.meeting, row };
  });
  await notify({
    chamberId: meeting.chamber_id,
    userIds: await inviteeIds(meeting.id),
    event: 'minutes.approved',
    title: 'صورتجلسه نهایی شد',
    body: `صورتجلسه «${meeting.title}» با شماره ${row.minutes_number} تأیید شد.`,
    data: { meetingId: meeting.id },
  });
  broadcastMeeting(meeting.id, { status: meeting.status });
  res.json(row);
});

/** The secretary takes submitted minutes back to correct them, before the chair has decided. */
minutesRouter.post('/minutes/:id/withdraw', async (req, res) => {
  const u = currentUser(req);
  const { meeting } = await tx(async (c) => {
    const { m, a } = await minutesAndAccess(u, param(req, 'id'), c);
    a.require('meeting.manage');
    await transition(c, req, a.meeting, 'withdraw_minutes');
    await c.query(`UPDATE minutes SET status = 'draft', submitted_at = NULL WHERE id = $1`, [m.id]);
    return { meeting: a.meeting };
  });
  const chairs = await query<{ user_id: string }>(
    `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position IN ('chair')`,
    [meeting.commission_id],
  );
  await notify({
    chamberId: meeting.chamber_id,
    userIds: chairs.map((x) => x.user_id),
    event: 'minutes.returned',
    title: 'صورتجلسه از تأیید پس گرفته شد',
    body: `دبیر صورتجلسه «${meeting.title}» را برای اصلاح پس گرفت؛ پس از اصلاح دوباره ارسال می‌شود.`,
    data: { meetingId: meeting.id },
  });
  broadcastMeeting(meeting.id, { status: meeting.status });
  res.status(204).end();
});

/**
 * Approved minutes are reopened only by the chamber admin, with a reason. The approved text stays in the
 * version history, the reopening is audited, and everyone invited is told; the chair approves it again.
 */
minutesRouter.post('/minutes/:id/reopen', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ reason: z.string().trim().min(5, 'دلیل بازگشایی را بنویسید') }));
  const { meeting } = await tx(async (c) => {
    const { m, a } = await minutesAndAccess(u, param(req, 'id'), c);
    if (!isChamberAdmin(u, a.meeting.chamber_id)) throw forbidden('بازگشایی صورتجلسهٔ تأییدشده فقط با مدیر اتاق است');
    if (m.status !== 'approved') throw conflict('این صورتجلسه تأیید نشده است', 'not_approved');
    await transition(c, req, a.meeting, 'reopen_minutes', { reason: b.reason });
    await c.query(
      `UPDATE minutes SET status = 'draft', reopened_at = now(), reopened_by = $2, reopen_reason = $3, return_reason = NULL, updated_at = now() WHERE id = $1`,
      [m.id, u.id, b.reason],
    );
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'minutes.reopened',
      entity: 'minutes',
      entityId: m.id,
      before: { number: m.minutes_number, version: m.version, contentHash: m.content_hash, approvedAt: m.approved_at },
      reason: b.reason,
    });
    return { meeting: a.meeting };
  });
  await notify({
    chamberId: meeting.chamber_id,
    userIds: await inviteeIds(meeting.id),
    event: 'minutes.reopened',
    title: 'صورتجلسه برای اصلاح بازگشایی شد',
    body: `صورتجلسه «${meeting.title}» به دلیل «${b.reason}» بازگشایی شد و پس از اصلاح دوباره تأیید می‌شود.`,
    data: { meetingId: meeting.id },
  });
  broadcastMeeting(meeting.id, { status: meeting.status });
  res.status(204).end();
});
