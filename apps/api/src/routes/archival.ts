import crypto from 'node:crypto';
import { isArchivalOpen, MEETING_TYPES, toJalali } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { commissionAccess, meetingAccess } from '../services/access.js';
import { ensureAttendanceRows } from '../services/meetings.js';
import { generateMinutesDraft } from '../services/minutes.js';
import { tehranDate } from '../services/holidays.js';

/**
 * Meetings recorded from the archive (ثبت از سوابق): meetings held before the system was in use. They are entered
 * with their real times, the members of that date, attendance, agenda, vote results and resolutions, then
 * finalized as minutes approved on paper (with the signed scan among the documents). Nobody is notified.
 */
export const archivalRouter = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ نامعتبر است');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ساعت باید به شکل ۱۰:۳۰ باشد');
/** Day and time in Iran → instant. */
const at = (d: string, t: string) => new Date(`${d}T${t}:00+03:30`);

archivalRouter.post('/meetings/archival', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    z
      .object({
        commissionId: uuid,
        number: z.number().int().positive().optional(),
        title: z.string().trim().min(2),
        date: day,
        startTime: time,
        endTime: time,
        location: z.string().trim().nullish(),
        type: z.enum(MEETING_TYPES).default('in_person'),
      })
      .refine((v) => v.endTime > v.startTime, { message: 'ساعت پایان باید بعد از ساعت شروع باشد', path: ['endTime'] }),
  );
  if (b.date > tehranDate(new Date())) throw badRequest('جلسهٔ سوابق باید در گذشته برگزار شده باشد؛ برای جلسهٔ آینده «جلسه جدید» را بزنید');
  const ca = await commissionAccess(u, b.commissionId);
  ca.require('meeting.manage');
  const row = await tx(async (c) => {
    await c.query('SELECT 1 FROM commissions WHERE id = $1 FOR UPDATE', [b.commissionId]);
    const number = b.number ?? (await one<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM meetings WHERE commission_id = $1', [b.commissionId], c))!.n;
    const start = at(b.date, b.startTime);
    const end = at(b.date, b.endTime);
    const m = await one(
      `INSERT INTO meetings (chamber_id, commission_id, number, title, scheduled_at, duration_minutes, location, type, status, archival,
          started_at, started_by, ended_at, ended_by, checkin_closed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'minutes_draft',true,$5,$9,$10,$9,$10,$9) RETURNING *`,
      [ca.commission.chamber_id, b.commissionId, number, b.title, start, Math.round((+end - +start) / 60000), b.location ?? null, b.type, u.id, end],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict(`جلسه شماره ${number} قبلاً در این کمیسیون ثبت شده است`, 'number_taken');
      throw e;
    });
    // The commission's members on that day (not today's), with their position then.
    await c.query(
      `INSERT INTO meeting_invitees (meeting_id, user_id, role, has_vote)
       SELECT DISTINCT ON (cm.user_id) $1, cm.user_id, cm.position, cm.has_vote FROM commission_memberships cm
        WHERE cm.commission_id = $2 AND cm.start_date <= $3::date AND (cm.end_date IS NULL OR cm.end_date >= $3::date)
        ORDER BY cm.user_id, cm.start_date DESC`,
      [m.id, b.commissionId, b.date],
    );
    await ensureAttendanceRows(m.id, c);
    await generateMinutesDraft(c, req, m.id);
    await audit(c, req, { chamberId: m.chamber_id, action: 'meeting.archival_created', entity: 'meeting', entityId: m.id, after: { ...b, number } });
    return m;
  });
  res.status(201).json(row);
});

/** Everyone listed (or all invitees) gets the same attendance — e.g. «همه حاضر» before marking the absent ones. */
archivalRouter.post('/meetings/:id/attendance/bulk', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ status: z.enum(['manual_present', 'absent', 'excused']), userIds: z.array(uuid).optional(), onlyUnset: z.boolean().default(false) }));
  const n = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isArchivalOpen(a.meeting)) throw conflict('ثبت گروهی حضور فقط برای جلسهٔ سوابق است');
    await ensureAttendanceRows(id, c);
    const r = await c.query(
      `UPDATE attendance SET status = $2, method = 'manual', note = COALESCE(note, 'ثبت از سوابق'), updated_by = $3, updated_at = now(),
              checked_in_at = CASE WHEN $2 = 'manual_present' THEN COALESCE(checked_in_at, (SELECT started_at FROM meetings WHERE id = $1)) END
        WHERE meeting_id = $1 AND ($4::uuid[] IS NULL OR user_id = ANY($4)) AND (NOT $5 OR status = 'pending')`,
      [id, b.status, u.id, b.userIds ?? null, b.onlyUnset],
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'attendance.bulk', entity: 'meeting', entityId: id, after: { status: b.status, count: r.rowCount } });
    return r.rowCount ?? 0;
  });
  res.json({ updated: n });
});

/** The result of a vote as written in the paper minutes (counts, and whether it passed). */
archivalRouter.post('/agenda-items/:id/vote/manual', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    z.object({
      title: z.string().trim().min(2).max(200).optional(),
      yes: z.number().int().min(0),
      no: z.number().int().min(0),
      abstain: z.number().int().min(0).default(0),
      passed: z.boolean(),
    }),
  );
  const item = await one('SELECT * FROM agenda_items WHERE id = $1', [param(req, 'id')]);
  if (!item) throw badRequest('آیتم دستور جلسه یافت نشد');
  const row = await tx(async (c) => {
    const a = await meetingAccess(u, item.meeting_id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isArchivalOpen(a.meeting)) throw conflict('ثبت دستی نتیجهٔ رأی فقط برای جلسهٔ سوابق است');
    const total = b.yes + b.no + b.abstain;
    const summary = `نتیجه رأی‌گیری — موافق: ${b.yes}، مخالف: ${b.no}، ممتنع: ${b.abstain}؛ مجموع آرا: ${total}؛ ${b.passed ? 'تصویب شد' : 'تصویب نشد'}`;
    const result = { counts: { yes: b.yes, no: b.no, abstain: b.abstain }, totalCast: total, passed: b.passed, summary, manual: true };
    const vs = await one(
      `INSERT INTO vote_sessions (chamber_id, meeting_id, agenda_item_id, title, pass_rule, status, opened_by, opened_at, closed_by, closed_at, result)
       VALUES ($1,$2,$3,$4,$5,'closed',$6,$7,$6,$7,$8) RETURNING *`,
      [a.meeting.chamber_id, a.meeting.id, item.id, b.title ?? `رأی‌گیری: ${item.title}`, a.settings.passRule, u.id, a.meeting.ended_at ?? a.meeting.scheduled_at, JSON.stringify(result)],
      c,
    );
    await c.query(`UPDATE agenda_items SET status = 'done', decision = COALESCE(decision, $2), updated_at = now() WHERE id = $1`, [item.id, b.passed ? 'تصویب شد' : 'تصویب نشد']);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'vote.recorded_manual', entity: 'vote_session', entityId: vs.id, after: result });
    return vs;
  });
  res.status(201).json(row);
});

/**
 * Finishes a meeting recorded from the archive: attendance not set counts as absent, the minutes text is rebuilt
 * from the data (unless kept as edited) and approved on paper. The meeting is then locked like any approved one.
 */
archivalRouter.post('/meetings/:id/archival/finalize', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ regenerate: z.boolean().default(true) }));
  const result = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    a.require('meeting.manage');
    if (!isArchivalOpen(a.meeting)) throw conflict('این جلسه در حال ثبت از سوابق نیست');
    await ensureAttendanceRows(id, c);
    const absent = await c.query(`UPDATE attendance SET status = 'absent', updated_at = now() WHERE meeting_id = $1 AND status = 'pending'`, [id]);
    const minutes = b.regenerate
      ? await generateMinutesDraft(c, req, id)
      : await one('SELECT * FROM minutes WHERE meeting_id = $1', [id], c);
    if (!minutes) throw conflict('متن صورتجلسه وجود ندارد');
    const fresh = await one<{ body: string }>('SELECT body FROM minutes WHERE id = $1', [minutes.id], c);
    const d = new Date(a.meeting.scheduled_at);
    const [jy] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const number = `${a.commission.code}/${jy}/${a.meeting.number}`;
    const hash = crypto.createHash('sha256').update(fresh!.body).digest('hex');
    await c.query(
      `UPDATE minutes SET status = 'approved', approved_by = $2, approved_at = now(), minutes_number = $3, content_hash = $4, updated_at = now() WHERE id = $1`,
      [minutes.id, u.id, number, hash],
    );
    await c.query(`UPDATE meetings SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
    const scans = await one<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE meeting_id = $1 AND kind = 'minutes_scan'`, [id], c);
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'meeting.archival_finalized',
      entity: 'meeting',
      entityId: id,
      after: { minutesNumber: number, contentHash: hash, markedAbsent: absent.rowCount, signedScans: scans?.n ?? 0, approvedOnPaper: true },
    });
    return { minutesNumber: number, markedAbsent: absent.rowCount ?? 0 };
  });
  res.json(result);
});

/** What is still missing before finalizing (shown to the operator). */
archivalRouter.get('/meetings/:id/archival/checklist', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  if (!a.meeting.archival) throw badRequest('این جلسه از سوابق ثبت نشده است');
  const [c] = await query(
    `SELECT
       (SELECT count(*)::int FROM meeting_invitees WHERE meeting_id = $1) AS invitees,
       (SELECT count(*)::int FROM meeting_invitees i LEFT JOIN attendance at ON at.meeting_id = i.meeting_id AND at.user_id = i.user_id
         WHERE i.meeting_id = $1 AND COALESCE(at.status, 'pending') = 'pending') AS attendance_unset,
       (SELECT count(*)::int FROM agenda_items WHERE meeting_id = $1 AND status <> 'removed') AS agenda,
       (SELECT count(*)::int FROM resolutions WHERE meeting_id = $1) AS resolutions,
       (SELECT count(*)::int FROM documents WHERE meeting_id = $1 AND kind = 'minutes_scan') AS signed_scans`,
    [a.meeting.id],
  );
  res.json({ ...c, open: isArchivalOpen(a.meeting) });
});
