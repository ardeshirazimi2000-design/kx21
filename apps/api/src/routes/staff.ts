import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { body, uuid } from '../lib/validate.js';
import { requireSuperAdmin } from '../services/access.js';
import { assertNotAdmin, assertNotAuditor, listStaff, separationWarnings, STAFF_ROLE_LABELS, STAFF_ROLES, type StaffRole } from '../services/staff.js';

/**
 * «نقش‌های مدیریتی»: the system's IT administrator hands the administrative roles to people, keeping the security
 * auditor apart from every administrator. Nobody changes their own roles; the last IT administrator stays.
 */
export const staffRouter = Router();

const PER_CHAMBER: readonly StaffRole[] = ['chamber_admin', 'it_admin'];
const SYSTEM_ONLY: readonly StaffRole[] = ['system_it', 'national'];

const roleSchema = z
  .object({ userId: uuid, role: z.enum(STAFF_ROLES), chamberId: uuid.nullish() })
  .refine((v) => !PER_CHAMBER.includes(v.role) || !!v.chamberId, 'اتاق را انتخاب کنید')
  .refine((v) => !SYSTEM_ONLY.includes(v.role) || !v.chamberId, 'این نقش برای کل سامانه است');

staffRouter.get('/staff-roles', async (req, res) => {
  requireSuperAdmin(currentUser(req));
  const rows = await listStaff();
  res.json({ items: rows, warnings: separationWarnings(rows), labels: STAFF_ROLE_LABELS });
});

staffRouter.post('/staff-roles', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const b = body(req, roleSchema);
  if (b.userId === u.id) throw badRequest('نقش‌های خودتان را نمی‌توانید تغییر دهید');
  const chamberId = b.chamberId ?? null;
  await tx(async (c) => {
    const p = await one('SELECT id, chamber_id, is_active, password_hash IS NOT NULL AS can_login FROM users WHERE id = $1 FOR UPDATE', [b.userId], c);
    if (!p) throw notFound('شخص یافت نشد');
    if (!p.is_active || !p.can_login) throw conflict('این شخص حساب ورود فعال ندارد؛ ابتدا برای او رمز عبور تعریف کنید', 'no_login');
    if (chamberId) {
      if (!(await one('SELECT 1 FROM chambers WHERE id = $1', [chamberId], c))) throw notFound('اتاق یافت نشد');
      if (PER_CHAMBER.includes(b.role) && p.chamber_id !== chamberId) throw badRequest('این شخص متعلق به اتاق دیگری است');
    }
    if (b.role === 'auditor') await assertNotAdmin(c, b.userId);
    else if (b.role !== 'national') await assertNotAuditor(c, b.userId);

    if (b.role === 'system_it') await c.query('UPDATE users SET is_super_admin = true WHERE id = $1', [b.userId]);
    else if (b.role === 'chamber_admin') await c.query('INSERT INTO chamber_admins (chamber_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [chamberId, b.userId]);
    else {
      await c.query(
        `INSERT INTO staff_roles (user_id, role, chamber_id, granted_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, role, COALESCE(chamber_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING`,
        [b.userId, b.role, chamberId, u.id],
      );
    }
    await audit(c, req, { chamberId, action: 'staff.role_granted', entity: 'user', entityId: b.userId, after: { role: b.role, label: STAFF_ROLE_LABELS[b.role], chamberId } });
  });
  res.status(201).json(await listStaff().then((rows) => rows.filter((r) => r.userId === b.userId)));
});

staffRouter.delete('/staff-roles', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const b = body(req, roleSchema);
  if (b.userId === u.id) throw badRequest('نقش‌های خودتان را نمی‌توانید تغییر دهید');
  const chamberId = b.chamberId ?? null;
  await tx(async (c) => {
    let removed = 0;
    if (b.role === 'system_it') {
      const [{ count }] = await query(`SELECT count(*)::int AS count FROM users WHERE is_super_admin AND is_active`, [], c);
      if (count <= 1) throw conflict('سامانه باید دست‌کم یک مدیر فناوری اطلاعات داشته باشد', 'last_it_admin');
      removed = (await c.query('UPDATE users SET is_super_admin = false WHERE id = $1 AND is_super_admin', [b.userId])).rowCount ?? 0;
    } else if (b.role === 'chamber_admin') {
      removed = (await c.query('DELETE FROM chamber_admins WHERE chamber_id = $1 AND user_id = $2', [chamberId, b.userId])).rowCount ?? 0;
    } else {
      removed = (await c.query('DELETE FROM staff_roles WHERE user_id = $1 AND role = $2 AND chamber_id IS NOT DISTINCT FROM $3', [b.userId, b.role, chamberId])).rowCount ?? 0;
    }
    if (!removed) throw notFound('این نقش ثبت نشده است');
    // Open sessions end, so the removed rights are not used any longer.
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [b.userId]);
    await audit(c, req, { chamberId, action: 'staff.role_revoked', entity: 'user', entityId: b.userId, before: { role: b.role, label: STAFF_ROLE_LABELS[b.role], chamberId } });
  });
  res.status(204).end();
});
