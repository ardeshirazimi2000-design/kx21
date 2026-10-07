import crypto from 'node:crypto';
import { BUILTIN_ROLES, CAPABILITY_LABELS, CONFIGURABLE_CAPABILITIES, LOCKED_ADMIN_CAPABILITIES } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { body, uuid } from '../lib/validate.js';
import { requireChamberAdmin, visibleChamberIds } from '../services/access.js';
import { customRoles, describeRoles, loadRoleMatrix } from '../services/roles.js';

/** Roles & permissions of a chamber (chamber admins of that chamber, or the super admin). */
export const rolesRouter = Router();

const capability = z.enum(CONFIGURABLE_CAPABILITIES);

async function snapshot(chamberId: string) {
  const [custom, matrix] = await Promise.all([customRoles(chamberId), loadRoleMatrix(chamberId)]);
  return describeRoles(custom, matrix);
}

rolesRouter.get('/roles', async (req, res) => {
  const chamberId = uuid.parse(req.query.chamberId);
  requireChamberAdmin(currentUser(req), chamberId);
  res.json({
    roles: await snapshot(chamberId),
    capabilities: CONFIGURABLE_CAPABILITIES.map((key) => ({ key, ...CAPABILITY_LABELS[key] })),
    lockedAdminCapabilities: LOCKED_ADMIN_CAPABILITIES,
  });
});

/** Roles usable as commission positions / meeting roles (for pickers; officers need it too). */
rolesRouter.get('/roles/options', async (req, res) => {
  const chamberId = uuid.parse(req.query.chamberId);
  const ids = await visibleChamberIds(currentUser(req));
  if (ids && !ids.includes(chamberId)) throw notFound();
  const custom = await customRoles(chamberId);
  res.json(custom.map((r) => ({ key: r.key, title: r.title, has_vote: r.has_vote })));
});

/** Replace the capability set of a role. */
rolesRouter.put('/roles/:key', async (req, res) => {
  const key = String(req.params.key);
  const b = body(req, z.object({ chamberId: uuid, capabilities: z.array(capability) }));
  requireChamberAdmin(currentUser(req), b.chamberId);
  const isBuiltin = (BUILTIN_ROLES as readonly string[]).includes(key);
  if (!isBuiltin && !(await one('SELECT 1 FROM custom_roles WHERE chamber_id = $1 AND key = $2', [b.chamberId, key]))) {
    throw notFound('نقش یافت نشد');
  }
  const caps = [...new Set(b.capabilities)];
  await tx(async (c) => {
    const before = await one('SELECT capabilities FROM role_permissions WHERE chamber_id = $1 AND role_key = $2', [b.chamberId, key], c);
    await c.query(
      `INSERT INTO role_permissions (chamber_id, role_key, capabilities, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (chamber_id, role_key) DO UPDATE SET capabilities = EXCLUDED.capabilities, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.chamberId, key, caps, req.user!.id],
    );
    await audit(c, req, { chamberId: b.chamberId, action: 'role.permissions_changed', entity: 'role', entityId: key, before: before?.capabilities ?? 'default', after: caps });
  });
  res.json(await snapshot(b.chamberId));
});

/** Restore the built-in default of a role. */
rolesRouter.post('/roles/:key/reset', async (req, res) => {
  const key = String(req.params.key);
  const b = body(req, z.object({ chamberId: uuid }));
  requireChamberAdmin(currentUser(req), b.chamberId);
  if (!(BUILTIN_ROLES as readonly string[]).includes(key)) throw badRequest('فقط نقش‌های پایه مقدار پیش‌فرض دارند');
  await tx(async (c) => {
    await c.query('DELETE FROM role_permissions WHERE chamber_id = $1 AND role_key = $2', [b.chamberId, key]);
    await audit(c, req, { chamberId: b.chamberId, action: 'role.permissions_reset', entity: 'role', entityId: key });
  });
  res.json(await snapshot(b.chamberId));
});

/** Define a custom role (e.g. «مشاور», «دبیر اجرایی»). */
rolesRouter.post('/roles', async (req, res) => {
  const b = body(
    req,
    z.object({
      chamberId: uuid,
      title: z.string().trim().min(2).max(60),
      description: z.string().max(300).nullish(),
      hasVote: z.boolean().default(false),
      capabilities: z.array(capability).default([]),
    }),
  );
  requireChamberAdmin(currentUser(req), b.chamberId);
  const key = `c_${crypto.randomBytes(4).toString('hex')}`;
  await tx(async (c) => {
    await c.query(
      `INSERT INTO custom_roles (chamber_id, key, title, description, has_vote, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [b.chamberId, key, b.title, b.description ?? null, b.hasVote, req.user!.id],
    ).catch((e) => {
      if (e.code === '23505') throw conflict('نقشی با این عنوان قبلاً تعریف شده است');
      throw e;
    });
    await c.query(`INSERT INTO role_permissions (chamber_id, role_key, capabilities, updated_by) VALUES ($1,$2,$3,$4)`, [
      b.chamberId, key, [...new Set(b.capabilities)], req.user!.id,
    ]);
    await audit(c, req, { chamberId: b.chamberId, action: 'role.created', entity: 'role', entityId: key, after: { title: b.title, hasVote: b.hasVote, capabilities: b.capabilities } });
  });
  res.status(201).json({ key, roles: await snapshot(b.chamberId) });
});

rolesRouter.patch('/roles/:key', async (req, res) => {
  const key = String(req.params.key);
  const b = body(req, z.object({ chamberId: uuid, title: z.string().trim().min(2).max(60).optional(), description: z.string().max(300).nullish(), hasVote: z.boolean().optional() }));
  requireChamberAdmin(currentUser(req), b.chamberId);
  await tx(async (c) => {
    const before = await one('SELECT * FROM custom_roles WHERE chamber_id = $1 AND key = $2 FOR UPDATE', [b.chamberId, key], c);
    if (!before) throw notFound('نقش یافت نشد');
    const after = await one(
      `UPDATE custom_roles SET title = COALESCE($3, title), description = COALESCE($4, description), has_vote = COALESCE($5, has_vote)
        WHERE chamber_id = $1 AND key = $2 RETURNING *`,
      [b.chamberId, key, b.title, b.description, b.hasVote],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('نقشی با این عنوان قبلاً تعریف شده است');
      throw e;
    });
    await audit(c, req, { chamberId: b.chamberId, action: 'role.updated', entity: 'role', entityId: key, before, after });
  });
  res.json(await snapshot(b.chamberId));
});

rolesRouter.delete('/roles/:key', async (req, res) => {
  const key = String(req.params.key);
  const chamberId = uuid.parse(req.query.chamberId);
  requireChamberAdmin(currentUser(req), chamberId);
  await tx(async (c) => {
    const role = await one('SELECT * FROM custom_roles WHERE chamber_id = $1 AND key = $2 FOR UPDATE', [chamberId, key], c);
    if (!role) throw notFound('نقش یافت نشد');
    const used = await one(
      `SELECT (SELECT count(*) FROM commission_memberships WHERE chamber_id = $1 AND position = $2 AND status = 'active') +
              (SELECT count(*) FROM meeting_invitees i JOIN meetings m ON m.id = i.meeting_id
                WHERE m.chamber_id = $1 AND i.role = $2 AND m.status NOT IN ('approved','archived','cancelled')) AS n`,
      [chamberId, key],
      c,
    );
    if (Number(used.n) > 0) throw conflict(`این نقش به ${used.n} عضویت یا دعوت فعال اختصاص دارد؛ ابتدا سمت آن‌ها را تغییر دهید`, 'role_in_use');
    await c.query('DELETE FROM role_permissions WHERE chamber_id = $1 AND role_key = $2', [chamberId, key]);
    await c.query('DELETE FROM custom_roles WHERE chamber_id = $1 AND key = $2', [chamberId, key]);
    await audit(c, req, { chamberId, action: 'role.deleted', entity: 'role', entityId: key, before: role });
  });
  res.status(204).end();
});

