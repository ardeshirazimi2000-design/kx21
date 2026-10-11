/** Operations: incidents, field tasks, public alerts and dashboard. Data is filtered by the role scope (city / district / own). */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { hmac } from '../lib/crypto.js';
import { getSettings } from '../security/settings.js';
import { sealIncident } from '../services/integrity.js';
import { auditReq } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { can, currentUser, requirePermission, scopeOf, type AuthUser } from '../security/middleware.js';

export const operationsRouter = Router();

const INCIDENT_TYPES = ['fire', 'flood', 'earthquake', 'building_collapse', 'gas_leak', 'storm', 'accident', 'other'] as const;

interface IncidentRow {
  id: string; status: string; district_id: number | null; reported_by: string | null; severity: number;
}

/** SQL predicate restricting incidents (alias i) to what `permission` lets the user see. */
function incidentScope(user: AuthUser, permission: string, params: unknown[]): string {
  const scope = scopeOf(user, permission);
  if (scope === 'city') return 'TRUE';
  if (scope === 'district') {
    if (user.districtId === null) return 'FALSE';
    params.push(user.districtId);
    return `i.district_id = $${params.length}`;
  }
  if (scope === 'own') {
    params.push(user.id);
    const n = params.length;
    return `(i.reported_by = $${n} OR EXISTS (SELECT 1 FROM tasks t WHERE t.incident_id = i.id AND t.assignee_id = $${n}))`;
  }
  return 'FALSE';
}

async function incidentInScope(user: AuthUser, permission: string, id: string): Promise<IncidentRow> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('حادثه یافت نشد');
  const params: unknown[] = [id];
  const where = incidentScope(user, permission, params);
  const row = await one<IncidentRow>(`SELECT i.id, i.status, i.district_id, i.reported_by, i.severity FROM incidents i WHERE i.id = $1 AND ${where}`, params);
  if (!row) {
    // Same answer whether it does not exist or is outside the user's scope.
    throw notFound('حادثه یافت نشد');
  }
  return row;
}

operationsRouter.get('/incidents', requirePermission('incidents.read'), async (req, res) => {
  const user = currentUser(req);
  const q = parse(
    z.object({
      status: z.string().max(20).optional(),
      districtId: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  const params: unknown[] = [];
  const where = [incidentScope(user, 'incidents.read', params)];
  if (q.status) where.push(`i.status = $${params.push(q.status)}`);
  if (q.districtId) where.push(`i.district_id = $${params.push(q.districtId)}`);
  params.push(q.limit, q.offset);
  res.json(
    await query(
      `SELECT i.*, d.name AS district_name, (SELECT count(*)::int FROM tasks t WHERE t.incident_id = i.id) AS task_count
         FROM incidents i LEFT JOIN districts d ON d.id = i.district_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
  );
});

operationsRouter.get('/incidents/:id', requirePermission('incidents.read'), async (req, res) => {
  const user = currentUser(req);
  const inc = await incidentInScope(user, 'incidents.read', req.params.id as string);
  const full = await one(`SELECT i.*, d.name AS district_name FROM incidents i LEFT JOIN districts d ON d.id = i.district_id WHERE i.id = $1`, [inc.id]);
  const tasks = await query(
    `SELECT t.id, t.title, t.status, t.note, t.created_at, t.updated_at, t.assignee_id, u.first_name || ' ' || u.last_name AS assignee_name
       FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.incident_id = $1
        AND ($2 OR t.assignee_id = $3) ORDER BY t.created_at`,
    [inc.id, scopeOf(user, 'tasks.read') !== 'own', user.id],
  );
  await auditReq(req, { action: 'incident.view', targetType: 'incident', targetId: inc.id });
  res.json({ ...full, tasks: can(user, 'tasks.read') ? tasks : [] });
});

/**
 * FDP_ETC.2: controlled export. Only holders of data.export, only within their scope, only while the administrator
 * allows exports, capped in size; the file carries its security attributes (who, when, scope, classification,
 * digest and HMAC signature) and every export is audited.
 */
operationsRouter.get('/export/incidents', requirePermission('data.export'), async (req, res) => {
  const user = currentUser(req);
  const st = await getSettings();
  if (!st['export.enabled']) throw forbidden('خروجی گرفتن از داده‌ها توسط مدیر سامانه غیرفعال شده است');
  const q = parse(z.object({ format: z.enum(['json', 'csv']).default('json'), status: z.string().max(20).optional() }), req.query);
  const params: unknown[] = [];
  const where = [incidentScope(user, 'data.export', params)];
  if (q.status) where.push(`i.status = $${params.push(q.status)}`);
  params.push(st['export.maxRows']);
  const rows = await query<Record<string, unknown>>(
    `SELECT i.id, i.title, i.type, i.severity, i.status, i.source, d.name AS district, i.address, i.lat, i.lng, i.created_at, i.declared_at, i.closed_at, i.integrity_ok
       FROM incidents i LEFT JOIN districts d ON d.id = i.district_id WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT $${params.length}`,
    params,
  );
  const body = q.format === 'csv' ? toCsv(rows) : JSON.stringify(rows);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const meta = {
    system: 'crisis-management', type: 'incidents', exportedBy: user.fullName, exportedAt: new Date().toISOString(),
    scope: scopeOf(user, 'data.export'), rows: rows.length, truncated: rows.length >= st['export.maxRows'], classification: 'محرمانه',
    sha256, signature: hmac(sha256, config.INTEGRITY_KEY),
  };
  await auditReq(req, { action: 'data.export', targetType: 'incidents', details: { rows: rows.length, format: q.format, sha256, status: q.status ?? null } });
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="incidents-${meta.exportedAt.slice(0, 10)}.csv"`);
    for (const [k, v] of Object.entries(meta)) res.setHeader(`X-Export-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, encodeURIComponent(String(v)));
    return void res.send(body);
  }
  res.json({ meta, records: rows });
});

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    let s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

const incidentInput = z.object({
  title: z.string().trim().min(3).max(150),
  type: z.enum(INCIDENT_TYPES),
  severity: z.number().int().min(1).max(4).default(1),
  description: z.string().trim().max(2000).optional(),
  districtId: z.number().int().positive().nullish(),
  address: z.string().trim().max(300).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

operationsRouter.post('/incidents', requirePermission('incidents.create', 'incidents.report'), async (req, res) => {
  const user = currentUser(req);
  const body = parse(incidentInput, req.body);
  // Operators register incidents; citizens/responders file reports (always "reported", severity capped).
  const asOperator = can(user, 'incidents.create') && user.channel === 'console';
  if (!asOperator && !can(user, 'incidents.report')) throw forbidden();
  let districtId = body.districtId ?? null;
  if (asOperator && scopeOf(user, 'incidents.create') === 'district') {
    if (districtId !== null && districtId !== user.districtId) throw forbidden('ثبت حادثه خارج از منطقه شما مجاز نیست');
    districtId = user.districtId;
  }
  if (districtId !== null && !(await one('SELECT 1 FROM districts WHERE id = $1', [districtId]))) throw badRequest('منطقه نامعتبر است');
  const source = asOperator ? 'operator' : user.kind === 'citizen' ? 'citizen' : 'responder';
  const row = await tx(async (db) => {
    const r = await one<{ id: string }>(
      `INSERT INTO incidents (title, type, severity, description, district_id, address, lat, lng, source, reported_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [body.title, body.type, asOperator ? body.severity : Math.min(body.severity, 2), body.description ?? null, districtId, body.address ?? null,
        body.lat ?? null, body.lng ?? null, source, user.id, asOperator ? 'verified' : 'reported'],
      db,
    );
    await sealIncident(r!.id, db);
    return r;
  });
  await auditReq(req, { action: 'incident.create', targetType: 'incident', targetId: row!.id, details: { source } });
  res.status(201).json(await one('SELECT * FROM incidents WHERE id = $1', [row!.id]));
});

operationsRouter.patch('/incidents/:id', requirePermission('incidents.update'), async (req, res) => {
  const user = currentUser(req);
  const inc = await incidentInScope(user, 'incidents.update', req.params.id as string);
  const body = parse(
    incidentInput.partial().extend({ status: z.enum(['reported', 'verified', 'rejected']).optional() }),
    req.body,
  );
  if (['closed', 'rejected'].includes(inc.status)) throw conflict('حادثه بسته شده قابل ویرایش نیست');
  if (body.status && inc.status !== 'reported' && inc.status !== 'verified') throw conflict('تغییر وضعیت از این مرحله با «اعلام» یا «خاتمه» انجام می‌شود');
  if (body.severity && body.severity >= 3 && !can(user, 'incidents.declare')) throw forbidden('تعیین سطح ۳ و ۴ نیازمند مجوز اعلام وضعیت بحران است');
  if (body.districtId !== undefined && scopeOf(user, 'incidents.update') === 'district' && body.districtId !== user.districtId) throw forbidden('انتقال حادثه به منطقه دیگر مجاز نیست');
  await tx(async (db) => {
    await db.query(
      `UPDATE incidents SET title = COALESCE($2, title), type = COALESCE($3, type), severity = COALESCE($4, severity),
              description = COALESCE($5, description), district_id = CASE WHEN $6 THEN $7::int ELSE district_id END,
              address = COALESCE($8, address), status = COALESCE($9, status), updated_at = now()
        WHERE id = $1`,
      [inc.id, body.title ?? null, body.type ?? null, body.severity ?? null, body.description ?? null, body.districtId !== undefined, body.districtId ?? null, body.address ?? null, body.status ?? null],
    );
    await sealIncident(inc.id, db);
  });
  await auditReq(req, { action: 'incident.update', targetType: 'incident', targetId: inc.id, details: { fields: Object.keys(body) } });
  res.json(await one('SELECT * FROM incidents WHERE id = $1', [inc.id]));
});

operationsRouter.post('/incidents/:id/declare', requirePermission('incidents.declare'), async (req, res) => {
  const user = currentUser(req);
  const inc = await incidentInScope(user, 'incidents.declare', req.params.id as string);
  const body = parse(z.object({ severity: z.number().int().min(1).max(4) }), req.body);
  if (!['reported', 'verified', 'active'].includes(inc.status)) throw conflict('این حادثه قابل اعلام نیست');
  await tx(async (db) => {
    await db.query(`UPDATE incidents SET status = 'active', severity = $2, declared_by = $3, declared_at = now(), updated_at = now() WHERE id = $1`, [inc.id, body.severity, user.id]);
    await sealIncident(inc.id, db);
  });
  await auditReq(req, { action: 'incident.declare', targetType: 'incident', targetId: inc.id, details: { severity: body.severity } });
  res.json(await one('SELECT * FROM incidents WHERE id = $1', [inc.id]));
});

operationsRouter.post('/incidents/:id/close', requirePermission('incidents.close'), async (req, res) => {
  const user = currentUser(req);
  const inc = await incidentInScope(user, 'incidents.close', req.params.id as string);
  const body = parse(z.object({ status: z.enum(['contained', 'closed']), note: z.string().trim().max(1000).optional() }), req.body);
  if (inc.status === 'closed' || inc.status === 'rejected') throw conflict('حادثه قبلاً بسته شده است');
  await tx(async (db) => {
    await db.query(
      `UPDATE incidents SET status = $2, closed_by = CASE WHEN $2 = 'closed' THEN $3::uuid ELSE closed_by END,
              closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END, updated_at = now() WHERE id = $1`,
      [inc.id, body.status, user.id],
    );
    await sealIncident(inc.id, db);
    if (body.status === 'closed') await db.query(`UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE incident_id = $1 AND status NOT IN ('done', 'cancelled')`, [inc.id]);
    await auditReq(req, { action: `incident.${body.status}`, targetType: 'incident', targetId: inc.id, details: { note: body.note } }, db);
  });
  res.json(await one('SELECT * FROM incidents WHERE id = $1', [inc.id]));
});

// ───── Tasks ─────

/** Staff who can receive field tasks, limited to the assigner's district when district-scoped. */
operationsRouter.get('/responders', requirePermission('tasks.assign'), async (req, res) => {
  const user = currentUser(req);
  const district = scopeOf(user, 'tasks.assign') === 'district' ? user.districtId ?? -1 : null;
  res.json(
    await query(
      `SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name AS name, u.organization, u.position_title, u.district_id,
              (SELECT count(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.status NOT IN ('done','cancelled')) AS open_tasks
         FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_key = ur.role_key
        WHERE rp.permission = 'tasks.update_own' AND u.status = 'active' AND u.kind = 'staff' AND u.app_access
          AND (ur.expires_at IS NULL OR ur.expires_at > now()) AND ($1::int IS NULL OR u.district_id = $1)
        ORDER BY name`,
      [district],
    ),
  );
});

operationsRouter.post('/incidents/:id/tasks', requirePermission('tasks.assign'), async (req, res) => {
  const user = currentUser(req);
  const inc = await incidentInScope(user, 'tasks.assign', req.params.id as string);
  if (!['verified', 'active', 'contained'].includes(inc.status)) throw conflict('مأموریت فقط برای حادثه تأییدشده قابل تعریف است');
  const body = parse(z.object({ title: z.string().trim().min(3).max(200), assigneeId: z.uuid(), note: z.string().trim().max(1000).optional() }), req.body);
  const assignee = await one<{ district_id: number | null }>(
    `SELECT u.district_id FROM users u
      WHERE u.id = $1 AND u.status = 'active' AND u.kind = 'staff' AND u.app_access
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_key = ur.role_key
                     WHERE ur.user_id = u.id AND rp.permission = 'tasks.update_own' AND (ur.expires_at IS NULL OR ur.expires_at > now()))`,
    [body.assigneeId],
  );
  if (!assignee) throw badRequest('کاربر انتخاب‌شده نیروی عملیاتی فعال نیست');
  if (scopeOf(user, 'tasks.assign') === 'district' && assignee.district_id !== user.districtId) throw forbidden('تخصیص به نیروی خارج از منطقه مجاز نیست');
  const row = await one<{ id: string }>(
    'INSERT INTO tasks (incident_id, title, assignee_id, note, assigned_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [inc.id, body.title, body.assigneeId, body.note ?? null, user.id],
  );
  await auditReq(req, { action: 'task.assign', targetType: 'task', targetId: row!.id, details: { incidentId: inc.id, assigneeId: body.assigneeId } });
  res.status(201).json(await one('SELECT * FROM tasks WHERE id = $1', [row!.id]));
});

operationsRouter.get('/tasks', requirePermission('tasks.read'), async (req, res) => {
  const user = currentUser(req);
  const scope = scopeOf(user, 'tasks.read');
  const params: unknown[] = [];
  let where = 'TRUE';
  if (scope === 'own') where = `t.assignee_id = $${params.push(user.id)}`;
  else if (scope === 'district') where = `i.district_id = $${params.push(user.districtId ?? -1)}`;
  res.json(
    await query(
      `SELECT t.*, i.title AS incident_title, i.type AS incident_type, i.severity, i.address, i.lat, i.lng,
              u.first_name || ' ' || u.last_name AS assignee_name
         FROM tasks t JOIN incidents i ON i.id = t.incident_id JOIN users u ON u.id = t.assignee_id
        WHERE ${where} ORDER BY (t.status IN ('done','cancelled')), t.created_at DESC LIMIT 200`,
      params,
    ),
  );
});

const TASK_FLOW: Record<string, string[]> = {
  assigned: ['accepted'],
  accepted: ['en_route'],
  en_route: ['on_site'],
  on_site: ['done'],
};

operationsRouter.patch('/tasks/:id/status', requirePermission('tasks.update_own'), async (req, res) => {
  const user = currentUser(req);
  const body = parse(z.object({ status: z.enum(['accepted', 'en_route', 'on_site', 'done']), note: z.string().trim().max(1000).optional() }), req.body);
  const id = req.params.id as string;
  const task = /^[0-9a-f-]{36}$/.test(id) ? await one<{ id: string; status: string; assignee_id: string }>('SELECT id, status, assignee_id FROM tasks WHERE id = $1', [id]) : null;
  if (!task || task.assignee_id !== user.id) throw notFound('مأموریت یافت نشد');
  if (!TASK_FLOW[task.status]?.includes(body.status)) throw conflict(`انتقال از «${task.status}» به «${body.status}» مجاز نیست`);
  await query('UPDATE tasks SET status = $2, note = COALESCE($3, note), updated_at = now() WHERE id = $1', [task.id, body.status, body.note ?? null]);
  await auditReq(req, { action: 'task.status', targetType: 'task', targetId: task.id, details: { from: task.status, to: body.status } });
  res.json(await one('SELECT * FROM tasks WHERE id = $1', [task.id]));
});

// ───── Alerts & dashboard ─────

operationsRouter.get('/alerts', requirePermission('alerts.read'), async (req, res) => {
  const user = currentUser(req);
  res.json(
    await query(
      `SELECT a.id, a.title, a.body, a.level, a.district_id, d.name AS district_name, a.incident_id, a.published_at
         FROM alerts a LEFT JOIN districts d ON d.id = a.district_id
        WHERE a.published_at > now() - interval '7 days' AND ($1::int IS NULL OR a.district_id IS NULL OR a.district_id = $1)
        ORDER BY a.published_at DESC LIMIT 50`,
      [user.channel === 'app' ? user.districtId : null],
    ),
  );
});

operationsRouter.post('/alerts', requirePermission('alerts.publish'), async (req, res) => {
  const user = currentUser(req);
  const body = parse(
    z.object({
      title: z.string().trim().min(3).max(120),
      body: z.string().trim().min(3).max(1000),
      level: z.enum(['info', 'warning', 'danger']),
      districtId: z.number().int().positive().nullish(),
      incidentId: z.uuid().nullish(),
    }),
    req.body,
  );
  if (body.level === 'danger' && !can(user, 'incidents.declare')) throw forbidden('هشدار سطح «خطر» فقط توسط مدیر بحران منتشر می‌شود');
  const row = await one<{ id: string }>(
    'INSERT INTO alerts (title, body, level, district_id, incident_id, published_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [body.title, body.body, body.level, body.districtId ?? null, body.incidentId ?? null, user.id],
  );
  await auditReq(req, { action: 'alert.publish', targetType: 'alert', targetId: row!.id, details: { level: body.level } });
  res.status(201).json(await one('SELECT * FROM alerts WHERE id = $1', [row!.id]));
});

operationsRouter.get('/reports/summary', requirePermission('reports.read'), async (req, res) => {
  const user = currentUser(req);
  const params: unknown[] = [];
  const where = incidentScope(user, 'reports.read', params);
  const byStatus = await query(`SELECT i.status, count(*)::int AS count FROM incidents i WHERE ${where} GROUP BY i.status`, params);
  const bySeverity = await query(
    `SELECT i.severity, count(*)::int AS count FROM incidents i WHERE ${where} AND i.status IN ('verified','active','contained') GROUP BY i.severity ORDER BY i.severity`,
    params,
  );
  const openTasks = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks t JOIN incidents i ON i.id = t.incident_id WHERE ${where} AND t.status NOT IN ('done','cancelled')`,
    params,
  );
  res.json({ byStatus, bySeverity, openTasks: openTasks?.count ?? 0 });
});
