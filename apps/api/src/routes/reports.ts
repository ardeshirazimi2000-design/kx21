import { formatJalaliDate, RESOLUTION_STATUS_LABELS, type ResolutionStatus } from '@kx/shared';
import { Router } from 'express';
import { currentUser } from '../auth/middleware.js';
import { one, query } from '../db/pool.js';
import { verifyAuditChain } from '../lib/audit.js';
import { forbidden } from '../lib/errors.js';
import { paged, pageParams, param, uuid } from '../lib/validate.js';
import { commissionAccess, requireChamberAdmin } from '../services/access.js';

export const reportsRouter = Router();

// ─────────────────────────────── Personal home (mobile "خانه من") ───────────────────────────────

reportsRouter.get('/me/home', async (req, res) => {
  const u = currentUser(req);
  const [upcoming, live, resolutions, referrals, unread] = await Promise.all([
    query(
      `SELECT m.id, m.title, m.number, m.scheduled_at, m.location, m.type, m.status, c.name AS commission_name, i.role AS my_role,
              a.status AS my_attendance
         FROM meeting_invitees i JOIN meetings m ON m.id = i.meeting_id JOIN commissions c ON c.id = m.commission_id
         LEFT JOIN attendance a ON a.meeting_id = m.id AND a.user_id = i.user_id
        WHERE i.user_id = $1 AND m.status IN ('scheduled','invitation_sent','checkin_open') AND m.scheduled_at > now() - interval '1 day'
        ORDER BY m.scheduled_at LIMIT 10`,
      [u.id],
    ),
    query(
      `SELECT m.id, m.title, m.number, m.status, c.name AS commission_name FROM meeting_invitees i JOIN meetings m ON m.id = i.meeting_id
         JOIN commissions c ON c.id = m.commission_id
        WHERE i.user_id = $1 AND m.status IN ('checkin_open','in_progress','agenda_processing') ORDER BY m.scheduled_at`,
      [u.id],
    ),
    query(
      `SELECT r.id, r.number, r.text, r.due_date, r.status, r.progress, (r.due_date < current_date) AS is_overdue
         FROM resolutions r WHERE r.owner_id = $1 AND r.status NOT IN ('done','cancelled') ORDER BY r.due_date NULLS LAST LIMIT 10`,
      [u.id],
    ),
    query(`SELECT id, request, due_date FROM referrals WHERE expert_id = $1 AND status = 'pending' ORDER BY due_date NULLS LAST`, [u.id]),
    one<{ count: number }>('SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]),
  ]);
  res.json({ upcoming, live, resolutions, referrals, unreadNotifications: unread?.count ?? 0 });
});

// ─────────────────────────────── Notifications ───────────────────────────────

reportsRouter.get('/notifications', async (req, res) => {
  const u = currentUser(req);
  const { page, pageSize, offset } = pageParams(req);
  const unread = req.query.unread === 'true';
  const items = await query(
    `SELECT id, event, title, body, data, channels, read_at, created_at FROM notifications
      WHERE user_id = $1 AND (NOT $2 OR read_at IS NULL) ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    [u.id, unread],
  );
  const [{ count }] = await query('SELECT count(*) FROM notifications WHERE user_id = $1 AND (NOT $2 OR read_at IS NULL)', [u.id, unread]);
  res.json(paged(items, count, page, pageSize));
});

reportsRouter.post('/notifications/:id/read', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [param(req, 'id'), currentUser(req).id]);
  res.status(204).end();
});

reportsRouter.post('/notifications/read-all', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [currentUser(req).id]);
  res.status(204).end();
});

// ─────────────────────────────── Dashboards ───────────────────────────────

async function commissionStats(commissionId: string) {
  const [meetings, attendance, resolutions, overdue, upcoming, referrals] = await Promise.all([
    one(
      `SELECT count(*) FILTER (WHERE status IN ('minutes_draft','pending_approval','approved','archived')) AS held,
              count(*) FILTER (WHERE status IN ('scheduled','invitation_sent','checkin_open')) AS upcoming,
              count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
              count(*) FILTER (WHERE status IN ('minutes_draft','pending_approval')) AS minutes_pending
         FROM meetings WHERE commission_id = $1`,
      [commissionId],
    ),
    one(
      `SELECT round(100.0 * count(*) FILTER (WHERE a.status IN ('present','online','proxy','manual_present')) / NULLIF(count(*), 0), 1) AS rate
         FROM attendance a JOIN meetings m ON m.id = a.meeting_id JOIN meeting_invitees i ON i.meeting_id = a.meeting_id AND i.user_id = a.user_id
        WHERE m.commission_id = $1 AND i.has_vote AND m.status IN ('minutes_draft','pending_approval','approved','archived')`,
      [commissionId],
    ),
    query(`SELECT status, count(*) FROM resolutions WHERE commission_id = $1 GROUP BY status`, [commissionId]),
    query(
      `SELECT r.id, r.number, r.text, r.due_date, r.progress, u.full_name AS owner_name, (current_date - r.due_date) AS days_late
         FROM resolutions r LEFT JOIN users u ON u.id = r.owner_id
        WHERE r.commission_id = $1 AND r.due_date < current_date AND r.status NOT IN ('done','cancelled') ORDER BY r.due_date LIMIT 20`,
      [commissionId],
    ),
    query(
      `SELECT id, number, title, scheduled_at, status FROM meetings WHERE commission_id = $1 AND status IN ('draft','scheduled','invitation_sent','checkin_open','in_progress','agenda_processing')
        ORDER BY scheduled_at LIMIT 5`,
      [commissionId],
    ),
    one(`SELECT count(*) FILTER (WHERE status = 'pending') AS pending FROM referrals WHERE commission_id = $1`, [commissionId]),
  ]);
  const byStatus = Object.fromEntries(resolutions.map((r: any) => [r.status, r.count]));
  return {
    meetings,
    attendanceRate: attendance?.rate === null || attendance?.rate === undefined ? null : Number(attendance.rate),
    resolutionsByStatus: byStatus,
    overdueResolutions: overdue,
    upcomingMeetings: upcoming,
    pendingReferrals: referrals?.pending ?? 0,
  };
}

reportsRouter.get('/dashboard/commission', async (req, res) => {
  const u = currentUser(req);
  const ca = await commissionAccess(u, uuid.parse(req.query.commissionId));
  ca.require('report.commission');
  res.json({ commission: { id: ca.commission.id, name: ca.commission.name }, ...(await commissionStats(ca.commission.id)) });
});

reportsRouter.get('/dashboard/chamber', async (req, res) => {
  const u = currentUser(req);
  const chamberId = uuid.parse(req.query.chamberId);
  requireChamberAdmin(u, chamberId);
  const commissions = await query(
    `SELECT c.id, c.name, c.code,
       (SELECT count(*) FROM meetings m WHERE m.commission_id = c.id AND m.status IN ('minutes_draft','pending_approval','approved','archived')) AS meetings_held,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id) AS resolutions_total,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.status = 'done') AS resolutions_done,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.due_date < current_date AND r.status NOT IN ('done','cancelled')) AS resolutions_overdue
     FROM commissions c JOIN terms t ON t.id = c.term_id WHERE c.chamber_id = $1 AND t.status = 'active' ORDER BY c.name`,
    [chamberId],
  );
  const overdue = await query(
    `SELECT r.id, r.number, r.text, r.due_date, r.progress, c.name AS commission_name, u.full_name AS owner_name, (current_date - r.due_date) AS days_late
       FROM resolutions r JOIN commissions c ON c.id = r.commission_id LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.chamber_id = $1 AND r.due_date < current_date AND r.status NOT IN ('done','cancelled') ORDER BY r.due_date LIMIT 50`,
    [chamberId],
  );
  const totals = await one(
    `SELECT (SELECT count(*) FROM commissions c JOIN terms t ON t.id = c.term_id WHERE c.chamber_id = $1 AND t.status = 'active' AND c.status = 'active') AS commissions,
            (SELECT count(*) FROM meetings WHERE chamber_id = $1 AND scheduled_at > now() - interval '30 days' AND status <> 'cancelled') AS meetings_30d,
            (SELECT count(*) FROM resolutions WHERE chamber_id = $1 AND status NOT IN ('done','cancelled')) AS open_resolutions,
            (SELECT count(*) FROM meetings WHERE chamber_id = $1 AND status IN ('in_progress','agenda_processing')) AS live_meetings`,
    [chamberId],
  );
  res.json({ totals, commissions, overdueResolutions: overdue });
});

// ─────────────────────────────── Reports & export ───────────────────────────────

function toCsv(rows: Record<string, unknown>[], headers: [string, string][]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return '﻿' + [headers.map((h) => esc(h[1])).join(','), ...rows.map((r) => headers.map(([k]) => esc(r[k])).join(','))].join('\r\n');
}

reportsRouter.get('/reports/resolutions', async (req, res) => {
  const u = currentUser(req);
  const commissionId = req.query.commissionId ? uuid.parse(req.query.commissionId) : null;
  const chamberId = req.query.chamberId ? uuid.parse(req.query.chamberId) : null;
  if (commissionId) (await commissionAccess(u, commissionId)).require('report.commission');
  else if (chamberId) requireChamberAdmin(u, chamberId);
  else throw forbidden('کمیسیون یا اتاق را مشخص کنید');
  const status = typeof req.query.status === 'string' ? req.query.status.split(',') : null;
  const rows = await query(
    `SELECT r.number, r.text, c.name AS commission_name, u.full_name AS owner_name, r.addressee, r.due_date, r.priority, r.status, r.progress,
            (r.due_date < current_date AND r.status NOT IN ('done','cancelled')) AS is_overdue, m.number AS meeting_number, r.created_at
       FROM resolutions r JOIN commissions c ON c.id = r.commission_id LEFT JOIN users u ON u.id = r.owner_id LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE ($1::uuid IS NULL OR r.commission_id = $1) AND ($2::uuid IS NULL OR r.chamber_id = $2) AND ($3::text[] IS NULL OR r.status = ANY($3))
      ORDER BY c.name, r.number`,
    [commissionId, chamberId, status],
  );
  if (req.query.format === 'csv') {
    const data = rows.map((r: any) => ({
      ...r,
      due_date: r.due_date ? formatJalaliDate(r.due_date + 'T12:00:00', false) : '',
      status: RESOLUTION_STATUS_LABELS[r.status as ResolutionStatus],
      is_overdue: r.is_overdue ? 'بله' : 'خیر',
      created_at: formatJalaliDate(r.created_at, false),
    }));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="resolutions.csv"');
    res.send(
      toCsv(data, [
        ['number', 'شماره'], ['text', 'متن مصوبه'], ['commission_name', 'کمیسیون'], ['meeting_number', 'جلسه'], ['owner_name', 'مسئول اجرا'],
        ['addressee', 'مخاطب'], ['due_date', 'مهلت'], ['status', 'وضعیت'], ['progress', 'پیشرفت'], ['is_overdue', 'معوق'], ['created_at', 'تاریخ ثبت'],
      ]),
    );
    return;
  }
  res.json(rows);
});

reportsRouter.get('/reports/attendance', async (req, res) => {
  const u = currentUser(req);
  const ca = await commissionAccess(u, uuid.parse(req.query.commissionId));
  ca.require('report.commission');
  res.json(
    await query(
      `SELECT u.id AS user_id, u.full_name, count(*) AS meetings,
              count(*) FILTER (WHERE a.status IN ('present','online','proxy','manual_present')) AS attended,
              count(*) FILTER (WHERE a.status = 'excused') AS excused,
              count(*) FILTER (WHERE a.status = 'absent') AS absent
         FROM attendance a JOIN meetings m ON m.id = a.meeting_id JOIN users u ON u.id = a.user_id
        WHERE m.commission_id = $1 AND m.status IN ('minutes_draft','pending_approval','approved','archived')
        GROUP BY u.id, u.full_name ORDER BY u.full_name`,
      [ca.commission.id],
    ),
  );
});

// ─────────────────────────────── Global search ───────────────────────────────

reportsRouter.get('/search', async (req, res) => {
  const u = currentUser(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) {
    res.json({ commissions: [], meetings: [], resolutions: [] });
    return;
  }
  const commissionVisible = `($2::boolean OR c.chamber_id = ANY($3::uuid[]) OR EXISTS (SELECT 1 FROM commission_memberships cm
     WHERE cm.commission_id = c.id AND cm.user_id = $4 AND cm.status = 'active' AND cm.position <> 'expert'))`;
  const p = [q, u.isSuperAdmin, u.adminChambers, u.id];
  const [commissions, meetings, resolutions] = await Promise.all([
    query(`SELECT c.id, c.name, c.code FROM commissions c WHERE c.name ILIKE '%' || $1 || '%' AND ${commissionVisible} LIMIT 10`, p),
    query(
      `SELECT m.id, m.title, m.number, m.scheduled_at, c.name AS commission_name FROM meetings m JOIN commissions c ON c.id = m.commission_id
        WHERE m.title ILIKE '%' || $1 || '%' AND (${commissionVisible} OR EXISTS (SELECT 1 FROM meeting_invitees i WHERE i.meeting_id = m.id AND i.user_id = $4))
        ORDER BY m.scheduled_at DESC LIMIT 10`,
      p,
    ),
    query(
      `SELECT r.id, r.number, r.text FROM resolutions r JOIN commissions c ON c.id = r.commission_id
        WHERE (r.text ILIKE '%' || $1 || '%' OR r.number ILIKE '%' || $1 || '%') AND (${commissionVisible} OR r.owner_id = $4) LIMIT 10`,
      p,
    ),
  ]);
  res.json({ commissions, meetings, resolutions });
});

// ─────────────────────────────── Audit log ───────────────────────────────

reportsRouter.get('/audit', async (req, res) => {
  const u = currentUser(req);
  const chamberId = req.query.chamberId ? uuid.parse(req.query.chamberId) : null;
  if (chamberId) requireChamberAdmin(u, chamberId);
  else if (!u.isSuperAdmin && !u.adminChambers.length) throw forbidden();
  // Without an explicit chamber, chamber admins see the logs of all chambers they administer.
  const scope = chamberId ? [chamberId] : u.isSuperAdmin ? null : u.adminChambers;
  const { page, pageSize, offset } = pageParams(req);
  const entity = typeof req.query.entity === 'string' ? req.query.entity : null;
  const entityId = typeof req.query.entityId === 'string' ? req.query.entityId : null;
  const action = typeof req.query.action === 'string' ? req.query.action : null;
  const where = `($1::uuid[] IS NULL OR l.chamber_id = ANY($1)) AND ($2::text IS NULL OR l.entity = $2) AND ($3::text IS NULL OR l.entity_id = $3)
    AND ($4::text IS NULL OR l.action LIKE $4 || '%')`;
  const params = [scope, entity, entityId, action];
  const items = await query(
    `SELECT l.*, u.full_name AS user_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id WHERE ${where}
      ORDER BY l.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  // Secret ballots: only super admins may see the recorded choice.
  const masked = items.map((l: any) =>
    l.action === 'vote.cast' && l.after?.secret && !u.isSuperAdmin ? { ...l, after: { secret: true, choice: '***' } } : l,
  );
  const [{ count }] = await query(`SELECT count(*) FROM audit_logs l WHERE ${where}`, params);
  res.json(paged(masked, count, page, pageSize));
});

reportsRouter.get('/audit/verify', async (req, res) => {
  const u = currentUser(req);
  const chamberId = req.query.chamberId ? uuid.parse(req.query.chamberId) : null;
  if (chamberId) requireChamberAdmin(u, chamberId);
  else if (!u.isSuperAdmin) throw forbidden();
  const brokenAt = await verifyAuditChain(chamberId);
  res.json({ intact: brokenAt === null, brokenAt });
});

