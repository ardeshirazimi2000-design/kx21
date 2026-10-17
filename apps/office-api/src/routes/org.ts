import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { revokeAllSessions } from '../auth/tokens.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { body, paged, pageParams, param, uuid } from '../lib/validate.js';
import { PERMISSIONS } from '../services/permissions.js';
import { passwordSchema } from './auth.js';

export const orgRouter = Router();

// ─────────────── Units (واحدهای سازمانی) ───────────────

orgRouter.get('/org/units', async (_req, res) => {
  const units = await query(
    `SELECT u.*, (SELECT count(*) FROM positions p WHERE p.unit_id = u.id) AS position_count FROM org_units u ORDER BY u.parent_id NULLS FIRST, u.name`,
  );
  const positions = await query(
    `SELECT p.*, (SELECT json_agg(json_build_object('id', us.id, 'full_name', us.full_name) ORDER BY us.full_name)
         FROM user_positions up JOIN users us ON us.id = up.user_id WHERE up.position_id = p.id AND (up.end_date IS NULL OR up.end_date >= current_date)) AS holders
       FROM positions p ORDER BY p.is_manager DESC, p.title`,
  );
  res.json({ units, positions });
});

const unitSchema = z.object({
  name: z.string().min(2).max(200),
  code: z.string().min(1).max(30),
  parentId: uuid.nullish(),
  kind: z.enum(['presidency', 'deputy', 'department', 'office', 'secretariat', 'committee']).default('department'),
  isActive: z.boolean().optional(),
});

orgRouter.post('/org/units', async (req, res) => {
  requirePerm(currentUser(req), 'org.manage');
  const b = body(req, unitSchema);
  const row = await tx(async (c) => {
    if (await one('SELECT 1 FROM org_units WHERE code = $1', [b.code], c)) throw conflict('کد واحد تکراری است');
    const r = await one(`INSERT INTO org_units (parent_id, name, code, kind) VALUES ($1,$2,$3,$4) RETURNING *`, [b.parentId ?? null, b.name, b.code, b.kind], c);
    await audit(c, req, { action: 'unit.created', entity: 'org_unit', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

orgRouter.patch('/org/units/:id', async (req, res) => {
  requirePerm(currentUser(req), 'org.manage');
  const id = param(req, 'id');
  const b = body(req, unitSchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM org_units WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    if (b.parentId) {
      // No cycles: the new parent must not be inside this unit's subtree.
      const cyc = await one(
        `WITH RECURSIVE t AS (SELECT id FROM org_units WHERE id = $1 UNION SELECT u.id FROM org_units u JOIN t ON u.parent_id = t.id) SELECT 1 FROM t WHERE id = $2`,
        [id, b.parentId],
        c,
      );
      if (cyc) throw badRequest('واحد نمی‌تواند زیرمجموعه خودش باشد');
    }
    const r = await one(
      `UPDATE org_units SET name = COALESCE($2, name), code = COALESCE($3, code), parent_id = CASE WHEN $4::boolean THEN $5 ELSE parent_id END,
         kind = COALESCE($6, kind), is_active = COALESCE($7, is_active) WHERE id = $1 RETURNING *`,
      [id, b.name, b.code, b.parentId !== undefined, b.parentId ?? null, b.kind, b.isActive],
      c,
    );
    await audit(c, req, { action: 'unit.updated', entity: 'org_unit', entityId: id, before, after: r });
    return r;
  });
  res.json(row);
});

// ─────────────── Positions (سمت‌ها) ───────────────

const positionSchema = z.object({ unitId: uuid, title: z.string().min(2).max(200), parentId: uuid.nullish(), isManager: z.boolean().default(false) });

orgRouter.post('/org/positions', async (req, res) => {
  requirePerm(currentUser(req), 'org.manage');
  const b = body(req, positionSchema);
  const row = await tx(async (c) => {
    if (b.isManager && (await one('SELECT 1 FROM positions WHERE unit_id = $1 AND is_manager', [b.unitId], c))) throw conflict('این واحد قبلاً سمت مدیر دارد');
    const r = await one(`INSERT INTO positions (unit_id, title, parent_id, is_manager) VALUES ($1,$2,$3,$4) RETURNING *`, [b.unitId, b.title, b.parentId ?? null, b.isManager], c);
    await audit(c, req, { action: 'position.created', entity: 'position', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

orgRouter.patch('/org/positions/:id', async (req, res) => {
  requirePerm(currentUser(req), 'org.manage');
  const id = param(req, 'id');
  const b = body(req, positionSchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM positions WHERE id = $1', [id], c);
    if (!before) throw notFound();
    const r = await one(
      `UPDATE positions SET unit_id = COALESCE($2, unit_id), title = COALESCE($3, title), parent_id = CASE WHEN $4::boolean THEN $5 ELSE parent_id END,
         is_manager = COALESCE($6, is_manager) WHERE id = $1 RETURNING *`,
      [id, b.unitId, b.title, b.parentId !== undefined, b.parentId ?? null, b.isManager],
      c,
    );
    await audit(c, req, { action: 'position.updated', entity: 'position', entityId: id, before, after: r });
    return r;
  });
  res.json(row);
});

// ─────────────── Users (کاربران) ───────────────

const USER_COLS = `u.id, u.username, u.full_name, u.national_id, u.email, u.mobile, u.is_active, u.clearance, u.mfa_enabled, u.last_login_at, u.created_at,
  u.signature_key IS NOT NULL AS has_signature, u.signature_updated_at`;

/** Directory used by pickers (any signed-in user). */
orgRouter.get('/users/directory', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  res.json(
    await query(
      `SELECT u.id, u.full_name, (SELECT string_agg(p.title || ' — ' || ou.name, '، ') FROM user_positions up JOIN positions p ON p.id = up.position_id
              JOIN org_units ou ON ou.id = p.unit_id WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date)) AS positions
         FROM users u WHERE u.is_active AND u.username <> 'system' AND ($1 = '' OR u.full_name ILIKE '%' || $1 || '%') ORDER BY u.full_name LIMIT 50`,
      [q],
    ),
  );
});

orgRouter.get('/users', async (req, res) => {
  requirePerm(currentUser(req), 'users.manage');
  const { page, pageSize, offset, q } = pageParams(req);
  const where = `u.username <> 'system' AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%' OR u.national_id = $1)`;
  const items = await query(
    `SELECT ${USER_COLS},
       (SELECT json_agg(json_build_object('positionId', p.id, 'title', p.title, 'unit', ou.name, 'isPrimary', up.is_primary))
          FROM user_positions up JOIN positions p ON p.id = up.position_id JOIN org_units ou ON ou.id = p.unit_id
         WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date)) AS positions,
       (SELECT json_agg(json_build_object('roleId', r.id, 'key', r.key, 'name', r.name, 'scopeUnitId', ur.scope_unit_id, 'scopeUnit', ou.name))
          FROM user_roles ur JOIN roles r ON r.id = ur.role_id LEFT JOIN org_units ou ON ou.id = ur.scope_unit_id WHERE ur.user_id = u.id) AS roles
     FROM users u WHERE ${where} ORDER BY u.full_name LIMIT ${pageSize} OFFSET ${offset}`,
    [q],
  );
  const [{ count }] = await query(`SELECT count(*) FROM users u WHERE ${where}`, [q]);
  res.json(paged(items, count, page, pageSize));
});

const userSchema = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'نام کاربری فقط حروف لاتین، عدد و . _ -'),
  fullName: z.string().min(3).max(200),
  nationalId: z.string().regex(/^\d{10}$/, 'کد ملی ۱۰ رقم است').nullish(),
  email: z.string().email().nullish(),
  mobile: z.string().regex(/^09\d{9}$/, 'شماره موبایل نامعتبر است').nullish(),
  password: passwordSchema.optional(),
  clearance: z.number().int().min(0).max(2).default(0),
  isActive: z.boolean().optional(),
  positions: z.array(z.object({ positionId: uuid, isPrimary: z.boolean().default(false) })).optional(),
  roles: z.array(z.object({ roleId: uuid, scopeUnitId: uuid.nullish() })).optional(),
});

async function setAssignments(c: any, userId: string, b: Partial<z.infer<typeof userSchema>>) {
  if (b.positions) {
    await c.query(`UPDATE user_positions SET end_date = current_date - 1 WHERE user_id = $1 AND end_date IS NULL AND NOT (position_id = ANY($2::uuid[]))`, [
      userId, b.positions.map((p) => p.positionId),
    ]);
    const primary = b.positions.find((p) => p.isPrimary)?.positionId ?? b.positions[0]?.positionId;
    for (const p of b.positions) {
      await c.query(
        `INSERT INTO user_positions (user_id, position_id, is_primary) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, position_id) DO UPDATE SET is_primary = EXCLUDED.is_primary, end_date = NULL`,
        [userId, p.positionId, p.positionId === primary],
      );
    }
  }
  if (b.roles) {
    await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    for (const r of b.roles) await c.query('INSERT INTO user_roles (user_id, role_id, scope_unit_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, r.roleId, r.scopeUnitId ?? null]);
  }
}

orgRouter.post('/users', async (req, res) => {
  requirePerm(currentUser(req), 'users.manage');
  const b = body(req, userSchema);
  const hash = b.password ? await bcrypt.hash(b.password, 10) : null;
  const row = await tx(async (c) => {
    if (await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username], c)) throw conflict('نام کاربری تکراری است');
    if (b.nationalId && (await one('SELECT 1 FROM users WHERE national_id = $1', [b.nationalId], c))) throw conflict('کد ملی تکراری است');
    const r = await one(
      `INSERT INTO users (username, full_name, national_id, email, mobile, password_hash, clearance) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, username, full_name, national_id, email, mobile, clearance, is_active`,
      [b.username, b.fullName, b.nationalId ?? null, b.email ?? null, b.mobile ?? null, hash, b.clearance],
      c,
    );
    await setAssignments(c, r.id, b);
    await audit(c, req, { action: 'user.created', entity: 'user', entityId: r.id, after: { ...r, positions: b.positions, roles: b.roles } });
    return r;
  });
  res.status(201).json(row);
});

orgRouter.patch('/users/:id', async (req, res) => {
  requirePerm(currentUser(req), 'users.manage');
  const id = param(req, 'id');
  const b = body(req, userSchema.partial().extend({ resetMfa: z.boolean().optional() }));
  const hash = b.password ? await bcrypt.hash(b.password, 10) : null;
  const row = await tx(async (c) => {
    const before = await one('SELECT id, username, full_name, national_id, email, mobile, clearance, is_active FROM users WHERE id = $1 FOR UPDATE', [id], c);
    if (!before || before.username === 'system') throw notFound();
    const r = await one(
      `UPDATE users SET full_name = COALESCE($2, full_name), national_id = COALESCE($3, national_id), email = COALESCE($4, email),
         mobile = COALESCE($5, mobile), password_hash = COALESCE($6, password_hash), clearance = COALESCE($7, clearance),
         is_active = COALESCE($8, is_active), mfa_enabled = CASE WHEN $9 THEN false ELSE mfa_enabled END,
         mfa_secret_enc = CASE WHEN $9 THEN NULL ELSE mfa_secret_enc END, updated_at = now()
       WHERE id = $1 RETURNING id, username, full_name, national_id, email, mobile, clearance, is_active`,
      [id, b.fullName, b.nationalId, b.email, b.mobile, hash, b.clearance, b.isActive, !!b.resetMfa],
      c,
    );
    await setAssignments(c, id, b);
    if (hash || b.isActive === false || b.resetMfa) await revokeAllSessions(id, c);
    await audit(c, req, { action: 'user.updated', entity: 'user', entityId: id, before, after: { ...r, positions: b.positions, roles: b.roles, resetMfa: b.resetMfa, passwordChanged: !!hash } });
    return r;
  });
  res.json(row);
});

// ─────────────── Roles & permissions (RBAC) ───────────────

orgRouter.get('/roles', async (_req, res) => {
  const roles = await query(
    `SELECT r.*, COALESCE((SELECT array_agg(permission_key ORDER BY permission_key) FROM role_permissions WHERE role_id = r.id), '{}') AS permissions,
       (SELECT count(*) FROM user_roles WHERE role_id = r.id) AS user_count FROM roles r ORDER BY r.is_system DESC, r.name`,
  );
  res.json({ roles, permissions: PERMISSIONS });
});

const roleSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().min(2).max(100),
  description: z.string().max(500).nullish(),
  permissions: z.array(z.enum(PERMISSIONS.map((p) => p.key) as [string, ...string[]])),
});

orgRouter.post('/roles', async (req, res) => {
  requirePerm(currentUser(req), 'roles.manage');
  const b = body(req, roleSchema);
  const row = await tx(async (c) => {
    if (await one('SELECT 1 FROM roles WHERE key = $1', [b.key], c)) throw conflict('کلید نقش تکراری است');
    const r = await one('INSERT INTO roles (key, name, description) VALUES ($1,$2,$3) RETURNING *', [b.key, b.name, b.description ?? null], c);
    for (const p of b.permissions) await c.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)', [r.id, p]);
    await audit(c, req, { action: 'role.created', entity: 'role', entityId: r.id, after: { ...r, permissions: b.permissions } });
    return r;
  });
  res.status(201).json(row);
});

orgRouter.patch('/roles/:id', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'roles.manage');
  const id = param(req, 'id');
  const b = body(req, roleSchema.omit({ key: true }).partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM roles WHERE id = $1', [id], c);
    if (!before) throw notFound();
    const beforePerms = (await query('SELECT permission_key FROM role_permissions WHERE role_id = $1', [id], c)).map((r) => r.permission_key);
    // Avoid locking everybody out: the admin role keeps role management.
    if (before.key === 'admin' && b.permissions && !b.permissions.includes('roles.manage')) throw badRequest('نقش مدیر سیستم باید مجوز مدیریت نقش‌ها را داشته باشد');
    const r = await one('UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1 RETURNING *', [id, b.name, b.description], c);
    if (b.permissions) {
      await c.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      for (const p of b.permissions) await c.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)', [id, p]);
    }
    await audit(c, req, { action: 'role.updated', entity: 'role', entityId: id, before: { ...before, permissions: beforePerms }, after: { ...r, permissions: b.permissions ?? beforePerms } });
    return r;
  });
  res.json(row);
});
