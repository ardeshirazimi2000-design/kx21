/** Console: roles & access matrix. Locked roles (security admin / auditor) are read-only. */
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.js';
import { auditReq } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { MUTUALLY_EXCLUSIVE_ROLES, PERMISSIONS, PERMISSION_KEYS, RESERVED_PERMISSIONS } from '../security/catalog.js';
import { requirePermission } from '../security/middleware.js';

export const rolesRouter = Router();

async function listRoles() {
  return query(
    `SELECT r.key, r.title, r.description, r.scope, r.builtin, r.locked, r.staff_only,
            COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions,
            (SELECT count(*)::int FROM user_roles ur WHERE ur.role_key = r.key) AS holders
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_key = r.key
      GROUP BY r.key ORDER BY r.builtin DESC, r.title`,
  );
}

rolesRouter.get('/', requirePermission('roles.read'), async (_req, res) => {
  res.json({ roles: await listRoles(), permissions: PERMISSIONS, mutuallyExclusive: MUTUALLY_EXCLUSIVE_ROLES });
});

const permissionList = z
  .array(z.string())
  .max(PERMISSION_KEYS.length)
  .transform((l) => [...new Set(l)])
  .superRefine((l, ctx) => {
    const unknown = l.filter((p) => !PERMISSION_KEYS.includes(p));
    if (unknown.length) ctx.addIssue({ code: 'custom', message: `مجوز ناشناخته: ${unknown.join('، ')}` });
    const reserved = l.filter((p) => RESERVED_PERMISSIONS.has(p));
    if (reserved.length) ctx.addIssue({ code: 'custom', message: `این مجوزها فقط در نقش‌های قفل‌شده امنیتی مجازند: ${reserved.join('، ')}` });
  });

const roleInput = z.object({
  title: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullish(),
  scope: z.enum(['city', 'district', 'own']),
  staffOnly: z.boolean().default(true),
  permissions: permissionList,
});

rolesRouter.post('/', requirePermission('roles.manage'), async (req, res) => {
  const body = parse(roleInput.extend({ key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/, 'کلید نقش: حروف کوچک لاتین، رقم و _') }), req.body);
  if (await one('SELECT 1 FROM roles WHERE key = $1 OR title = $2', [body.key, body.title])) throw conflict('نقشی با این کلید یا عنوان وجود دارد');
  if (!body.staffOnly && body.permissions.includes('console.access')) throw badRequest('نقش قابل تخصیص به شهروندان نمی‌تواند دسترسی کنسول داشته باشد');
  await tx(async (db) => {
    await db.query('INSERT INTO roles (key, title, description, scope, staff_only) VALUES ($1,$2,$3,$4,$5)', [body.key, body.title, body.description ?? null, body.scope, body.staffOnly]);
    for (const p of body.permissions) await db.query('INSERT INTO role_permissions (role_key, permission) VALUES ($1,$2)', [body.key, p]);
    await auditReq(req, { action: 'role.create', targetType: 'role', targetId: body.key, details: { permissions: body.permissions, scope: body.scope } }, db);
  });
  res.status(201).json((await listRoles()).find((r) => r.key === body.key));
});

rolesRouter.put('/:key', requirePermission('roles.manage'), async (req, res) => {
  const key = req.params.key as string;
  const role = await one<{ key: string; locked: boolean; staff_only: boolean; builtin: boolean }>('SELECT key, locked, staff_only, builtin FROM roles WHERE key = $1', [key]);
  if (!role) throw notFound('نقش یافت نشد');
  if (role.locked) throw forbidden('نقش‌های امنیتی قفل‌شده قابل ویرایش نیستند');
  const body = parse(roleInput, req.body);
  if (role.builtin && body.staffOnly !== role.staff_only) throw badRequest('نوع کاربران مجاز نقش پیش‌فرض قابل تغییر نیست');
  if (!body.staffOnly && body.permissions.includes('console.access')) throw badRequest('نقش قابل تخصیص به شهروندان نمی‌تواند دسترسی کنسول داشته باشد');
  if (body.staffOnly && (await one(`SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_key = $1 AND u.kind = 'citizen' LIMIT 1`, [key]))) {
    throw conflict('این نقش به شهروندان تخصیص داده شده و نمی‌تواند «فقط کارکنان» شود');
  }
  if (await one('SELECT 1 FROM roles WHERE title = $1 AND key <> $2', [body.title, key])) throw conflict('عنوان نقش تکراری است');
  const before = await query<{ permission: string }>('SELECT permission FROM role_permissions WHERE role_key = $1', [key]);
  await tx(async (db) => {
    await db.query('UPDATE roles SET title=$2, description=$3, scope=$4, staff_only=$5, updated_at=now() WHERE key=$1', [key, body.title, body.description ?? null, body.scope, body.staffOnly]);
    await db.query('DELETE FROM role_permissions WHERE role_key = $1', [key]);
    for (const p of body.permissions) await db.query('INSERT INTO role_permissions (role_key, permission) VALUES ($1,$2)', [key, p]);
    const prev = before.map((b) => b.permission);
    await auditReq(req, {
      action: 'role.update', targetType: 'role', targetId: key,
      details: { added: body.permissions.filter((p) => !prev.includes(p)), removed: prev.filter((p) => !body.permissions.includes(p)), scope: body.scope },
    }, db);
  });
  res.json((await listRoles()).find((r) => r.key === key));
});

rolesRouter.delete('/:key', requirePermission('roles.manage'), async (req, res) => {
  const key = req.params.key as string;
  const role = await one<{ builtin: boolean }>('SELECT builtin FROM roles WHERE key = $1', [key]);
  if (!role) throw notFound('نقش یافت نشد');
  if (role.builtin) throw forbidden('نقش‌های پیش‌فرض سامانه قابل حذف نیستند');
  if (await one('SELECT 1 FROM user_roles WHERE role_key = $1 LIMIT 1', [key])) throw conflict('ابتدا این نقش را از کاربران سلب کنید');
  await tx(async (db) => {
    await db.query('DELETE FROM roles WHERE key = $1', [key]);
    await auditReq(req, { action: 'role.delete', targetType: 'role', targetId: key }, db);
  });
  res.status(204).end();
});
