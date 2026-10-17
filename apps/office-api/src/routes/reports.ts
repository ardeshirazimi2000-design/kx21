import { formatJalaliDate, formatJalaliDateTime, toJalali } from '@kx/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { dateStr, parse } from '../lib/validate.js';
import { buildCsv, buildXlsx } from '../lib/xlsx.js';

export const reportsRouter = Router();

const KIND: Record<string, string> = { incoming: 'وارده', outgoing: 'صادره', internal: 'داخلی' };
const STATUS: Record<string, string> = {
  draft: 'پیش‌نویس', registered: 'ثبت‌شده', in_progress: 'در جریان', approved: 'تأییدشده', signed: 'امضاشده', sent: 'ارسال‌شده', archived: 'بایگانی', cancelled: 'ابطال',
};

/** Period (default: last 30 days) and the units the user may report on (null = all). */
function scope(req: Request) {
  const u = currentUser(req);
  requirePerm(u, 'reports.view');
  const f = parse(z.object({ from: dateStr.optional(), to: dateStr.optional() }), req.query);
  const to = f.to ?? new Date().toISOString().slice(0, 10);
  const from = f.from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('بازه تاریخ نامعتبر است');
  return { from, to, units: u.unitsFor('reports.view') };
}

const ROUTING_UNIT = `COALESCE(p.unit_id, (SELECT p2.unit_id FROM user_positions up JOIN positions p2 ON p2.id = up.position_id
   WHERE up.user_id = r.to_user_id AND (up.end_date IS NULL OR up.end_date >= current_date) ORDER BY up.is_primary DESC LIMIT 1))`;

async function unitPerformance(from: string, to: string, units: string[] | null) {
  return query(
    `WITH rt AS (
       SELECT r.*, ${ROUTING_UNIT} AS unit_id FROM letter_routing r LEFT JOIN positions p ON p.id = r.to_position_id
        WHERE r.action <> 'info' AND r.status <> 'cancelled' AND r.created_at < $2::date + 1
     )
     SELECT ou.id, ou.name,
       (SELECT count(*) FROM letters l WHERE l.owner_unit_id = ou.id AND l.registered_at >= $1::date AND l.registered_at < $2::date + 1) AS letters,
       count(rt.id) FILTER (WHERE rt.created_at >= $1::date) AS referrals,
       count(rt.id) FILTER (WHERE rt.status IN ('done','returned') AND rt.done_at >= $1::date AND rt.done_at < $2::date + 1) AS done,
       count(rt.id) FILTER (WHERE rt.status IN ('pending','seen')) AS pending,
       count(rt.id) FILTER (WHERE rt.status IN ('pending','seen') AND rt.due_at < now()) AS overdue,
       round(avg(EXTRACT(epoch FROM rt.done_at - rt.created_at) / 3600) FILTER (WHERE rt.done_at >= $1::date AND rt.done_at < $2::date + 1)::numeric, 1) AS avg_response_hours
       FROM org_units ou LEFT JOIN rt ON rt.unit_id = ou.id
      WHERE ($3::uuid[] IS NULL OR ou.id = ANY($3))
      GROUP BY ou.id, ou.name ORDER BY ou.name`,
    [from, to, units],
  );
}

reportsRouter.get('/reports/dashboard', async (req, res) => {
  const { from, to, units } = scope(req);
  const lw = `l.registered_at >= $1::date AND l.registered_at < $2::date + 1 AND ($3::uuid[] IS NULL OR l.owner_unit_id = ANY($3))`;
  const [byKind, byStatus, monthly, routing, workflows, unitsPerf, resolutions, sources] = await Promise.all([
    query(`SELECT kind, count(*) AS n FROM letters l WHERE ${lw} GROUP BY kind`, [from, to, units]),
    query(`SELECT status, count(*) AS n FROM letters l WHERE ($3::uuid[] IS NULL OR l.owner_unit_id = ANY($3)) AND l.created_at < $2::date + 1 AND (l.created_at >= $1::date OR l.status NOT IN ('archived','cancelled','sent')) GROUP BY status`, [from, to, units]),
    query(`SELECT kind, registered_at FROM letters l WHERE l.registered_at >= ($1::date - interval '365 days') AND l.registered_at < $1::date + 1 AND ($2::uuid[] IS NULL OR l.owner_unit_id = ANY($2))`, [to, units]),
    query(
      `SELECT count(*) FILTER (WHERE r.status IN ('pending','seen')) AS pending,
              count(*) FILTER (WHERE r.status IN ('pending','seen') AND r.due_at < now()) AS overdue,
              count(*) FILTER (WHERE r.done_at >= $1::date AND r.done_at < $2::date + 1) AS done,
              round(avg(EXTRACT(epoch FROM r.done_at - r.created_at) / 3600) FILTER (WHERE r.done_at >= $1::date AND r.done_at < $2::date + 1)::numeric, 1) AS avg_response_hours,
              round((percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM r.done_at - r.created_at) / 3600)
                 FILTER (WHERE r.done_at >= $1::date AND r.done_at < $2::date + 1))::numeric, 1) AS p90_response_hours
         FROM letter_routing r JOIN letters l ON l.id = r.letter_id WHERE r.action <> 'info' AND r.status <> 'cancelled'
          AND ($3::uuid[] IS NULL OR l.owner_unit_id = ANY($3))`,
      [from, to, units],
    ),
    query(
      `SELECT count(*) FILTER (WHERE wi.status = 'running') AS running,
              count(*) FILTER (WHERE wi.status = 'completed' AND wi.completed_at >= $1::date AND wi.completed_at < $2::date + 1) AS completed,
              count(*) FILTER (WHERE wi.status = 'rejected' AND wi.completed_at >= $1::date AND wi.completed_at < $2::date + 1) AS rejected,
              round(avg(EXTRACT(epoch FROM wi.completed_at - wi.started_at) / 3600) FILTER (WHERE wi.status = 'completed' AND wi.completed_at >= $1::date AND wi.completed_at < $2::date + 1)::numeric, 1) AS avg_hours,
              (SELECT count(*) FROM workflow_steps ws WHERE ws.status = 'active' AND ws.due_at < now()) AS overdue_steps,
              (SELECT count(*) FROM workflow_steps ws WHERE ws.escalated_at >= $1::date AND ws.escalated_at < $2::date + 1) AS escalations
         FROM workflow_instances wi JOIN letters l ON l.id = wi.letter_id WHERE ($3::uuid[] IS NULL OR l.owner_unit_id = ANY($3))`,
      [from, to, units],
    ),
    unitPerformance(from, to, units),
    query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE status IN ('done')) AS done, count(*) FILTER (WHERE status = 'submitted') AS submitted,
              count(*) FILTER (WHERE status NOT IN ('done','cancelled') AND due_date < current_date) AS overdue,
              round(avg(progress)::numeric, 0) AS avg_progress FROM resolutions_cache`,
    ),
    query(`SELECT source, count(*) AS n FROM letters l WHERE ${lw} GROUP BY source`, [from, to, units]),
  ]);
  // Jalali months of the last 12 months.
  const months = new Map<string, { label: string; incoming: number; outgoing: number; internal: number }>();
  for (const r of monthly) {
    const d = new Date(r.registered_at);
    const [jy, jm] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const key = `${jy}-${String(jm).padStart(2, '0')}`;
    const m = months.get(key) ?? { label: key, incoming: 0, outgoing: 0, internal: 0 };
    m[r.kind as 'incoming' | 'outgoing' | 'internal']++;
    months.set(key, m);
  }
  res.json({
    period: { from, to },
    letters: {
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      bySource: Object.fromEntries(sources.map((r) => [r.source, r.n])),
      monthly: [...months.values()].sort((a, b) => a.label.localeCompare(b.label)),
    },
    routing: routing[0],
    workflows: workflows[0],
    units: unitsPerf,
    resolutions: resolutions[0],
  });
});

reportsRouter.get('/reports/export', async (req, res) => {
  const { from, to, units } = scope(req);
  const f = parse(z.object({ report: z.enum(['letters', 'units', 'routing']), format: z.enum(['xlsx', 'csv']).default('xlsx') }), req.query);
  let header: string[];
  let rows: (string | number | null)[][];
  let title: string;
  if (f.report === 'letters') {
    title = 'مکاتبات';
    header = ['شماره', 'نوع', 'تاریخ ثبت', 'موضوع', 'طرف مکاتبه', 'واحد', 'اولویت', 'وضعیت', 'کد رهگیری'];
    const r = await query(
      `SELECT l.*, ou.name AS unit FROM letters l LEFT JOIN org_units ou ON ou.id = l.owner_unit_id
        WHERE l.registered_at >= $1::date AND l.registered_at < $2::date + 1 AND ($3::uuid[] IS NULL OR l.owner_unit_id = ANY($3)) AND l.confidentiality = 0
        ORDER BY l.registered_at`,
      [from, to, units],
    );
    rows = r.map((l) => [l.number, KIND[l.kind], formatJalaliDate(l.registered_at, false), l.subject, l.external_org ?? l.external_party, l.unit, l.priority, STATUS[l.status], l.tracking_code]);
  } else if (f.report === 'units') {
    title = 'عملکرد واحدها';
    header = ['واحد', 'نامه‌های ثبت‌شده', 'ارجاعات دریافتی', 'انجام‌شده', 'در انتظار', 'معوق', 'میانگین زمان پاسخ (ساعت)'];
    rows = (await unitPerformance(from, to, units)).map((u) => [u.name, u.letters, u.referrals, u.done, u.pending, u.overdue, u.avg_response_hours === null ? null : Number(u.avg_response_hours)]);
  } else {
    title = 'ارجاعات';
    header = ['شماره نامه', 'موضوع', 'از', 'به', 'اقدام', 'تاریخ ارجاع', 'مهلت', 'وضعیت', 'زمان پاسخ (ساعت)'];
    const r = await query(
      `SELECT r.*, l.number, l.subject, fu.full_name AS from_name, COALESCE(tu.full_name, p.title) AS to_name
         FROM letter_routing r JOIN letters l ON l.id = r.letter_id LEFT JOIN users fu ON fu.id = r.from_user_id
         LEFT JOIN users tu ON tu.id = r.to_user_id LEFT JOIN positions p ON p.id = r.to_position_id
        WHERE r.created_at >= $1::date AND r.created_at < $2::date + 1 AND ($3::uuid[] IS NULL OR l.owner_unit_id = ANY($3)) AND l.confidentiality = 0
        ORDER BY r.created_at`,
      [from, to, units],
    );
    rows = r.map((x) => [
      x.number, x.subject, x.from_name ?? 'سامانه', x.to_name, x.action, formatJalaliDateTime(x.created_at), x.due_at ? formatJalaliDateTime(x.due_at) : null, x.status,
      x.done_at ? Math.round(((new Date(x.done_at).getTime() - new Date(x.created_at).getTime()) / 3600_000) * 10) / 10 : null,
    ]);
  }
  const name = `${title}-${from}-${to}.${f.format}`;
  const buf = f.format === 'xlsx' ? buildXlsx(title, header, rows) : buildCsv(header, rows);
  res.setHeader('content-type', f.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buf);
});
