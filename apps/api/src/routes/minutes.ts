import crypto from 'node:crypto';
import { toJalali } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { body, param } from '../lib/validate.js';
import { meetingAccess } from '../services/access.js';
import { broadcastMeeting, inviteeIds, transition } from '../services/meetings.js';
import { generateMinutesDraft } from '../services/minutes.js';
import { notify } from '../services/notifications.js';

export const minutesRouter = Router();

minutesRouter.get('/meetings/:id/minutes', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  a.require('minutes.view');
  const m = await one('SELECT * FROM minutes WHERE meeting_id = $1', [a.meeting.id]);
  if (!m) throw notFound('صورتجلسه هنوز ایجاد نشده است');
  // Drafts are internal to the officers until approved.
  if (m.status !== 'approved' && !a.can('meeting.manage') && !a.can('minutes.approve')) throw notFound('صورتجلسه هنوز نهایی نشده است');
  const versions = a.can('meeting.manage')
    ? await query(
        `SELECT v.version, v.created_at, u.full_name AS edited_by FROM minutes_versions v LEFT JOIN users u ON u.id = v.edited_by
          WHERE v.minutes_id = $1 ORDER BY v.version DESC`,
        [m.id],
      )
    : [];
  res.json({ ...m, versions, capabilities: [...a.caps] });
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
  const { meeting } = await tx(async (c) => {
    const { m, a } = await minutesAndAccess(u, param(req, 'id'), c);
    a.require('meeting.manage');
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
