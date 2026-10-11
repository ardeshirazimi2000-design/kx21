/** Console: user administration. Every staff account is created only after a Shahkar match. */
import { Router } from 'express';
import { z } from 'zod';
import { one, pool, query, tx } from '../db/pool.js';
import { auditReq } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isValidNationalCode, maskMobile, maskNationalCode, normalizeMobile, normalizeNationalCode } from '../lib/identity.js';
import { parse } from '../lib/validate.js';
import { currentUser, requirePermission } from '../security/middleware.js';
import { setPassword, temporaryPassword } from '../security/password.js';
import { assertAnotherSecurityAdmin, setUserRoles } from '../security/roles.js';
import { revokeSession, revokeUserSessions } from '../security/sessions.js';
import { inquireShahkar, requireShahkarMatch } from '../services/shahkar.js';

export const usersRouter = Router();

const nationalCode = z.string().transform(normalizeNationalCode).refine(isValidNationalCode, 'کد ملی نامعتبر است');
const mobile = z.string().transform((m, ctx) => {
  const n = normalizeMobile(m);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'شماره موبایل نامعتبر است' });
    return z.NEVER;
  }
  return n;
});
const username = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{3,31}$/, 'نام کاربری باید با حرف لاتین شروع شود (۴ تا ۳۲ کاراکتر)');
const roleGrants = z.array(z.object({ key: z.string().max(64), expiresAt: z.iso.datetime({ offset: true }).nullish() })).max(20);

const USER_COLUMNS = `u.id, u.national_code, u.mobile, u.first_name, u.last_name, u.kind, u.organization, u.position_title,
  u.district_id, d.name AS district_name, u.username, u.console_access, u.app_access, u.status, u.must_change_password,
  u.failed_logins, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked, u.shahkar_verified_at,
  u.app_enrolled_at, u.last_login_at, u.created_at,
  COALESCE((SELECT json_agg(json_build_object('key', r.key, 'title', r.title, 'expiresAt', ur.expires_at) ORDER BY r.title)
              FROM user_roles ur JOIN roles r ON r.key = ur.role_key WHERE ur.user_id = u.id), '[]') AS roles`;

interface UserRow {
  id: string; national_code: string; mobile: string; kind: string; [k: string]: unknown;
}

/** Identity data is shown masked to holders of users.read; full values only to user administrators. */
function present(row: UserRow, full: boolean) {
  return full ? row : { ...row, national_code: maskNationalCode(row.national_code), mobile: maskMobile(row.mobile) };
}

async function loadUser(id: string): Promise<UserRow> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('کاربر یافت نشد');
  const u = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users u LEFT JOIN districts d ON d.id = u.district_id WHERE u.id = $1`, [id]);
  if (!u) throw notFound('کاربر یافت نشد');
  return u;
}

usersRouter.get('/', requirePermission('users.read'), async (req, res) => {
  const q = parse(
    z.object({
      q: z.string().max(64).optional(),
      role: z.string().max(64).optional(),
      status: z.enum(['active', 'suspended', 'disabled']).optional(),
      kind: z.enum(['staff', 'citizen']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  const rows = await query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN districts d ON d.id = u.district_id
      WHERE ($1::text IS NULL OR u.first_name || ' ' || u.last_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%' OR u.national_code = $1 OR u.mobile = $1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_key = $2))
        AND ($3::text IS NULL OR u.status = $3)
        AND ($4::text IS NULL OR u.kind = $4)
      ORDER BY u.created_at DESC LIMIT $5 OFFSET $6`,
    [q.q || null, q.role || null, q.status ?? null, q.kind ?? null, q.limit, q.offset],
  );
  const full = currentUser(req).access.permissions.has('users.update');
  res.json(rows.map((r) => present(r, full)));
});

usersRouter.get('/:id', requirePermission('users.read'), async (req, res) => {
  const u = await loadUser(req.params.id as string);
  res.json(present(u, currentUser(req).access.permissions.has('users.update')));
});

const createInput = z.object({
  nationalCode,
  mobile,
  firstName: z.string().trim().min(2).max(50),
  lastName: z.string().trim().min(2).max(50),
  organization: z.string().trim().max(100).optional(),
  positionTitle: z.string().trim().max(100).optional(),
  districtId: z.number().int().positive().nullish(),
  consoleAccess: z.boolean().default(false),
  appAccess: z.boolean().default(true),
  username: username.optional(),
  roles: roleGrants.default([]),
});

usersRouter.post('/', requirePermission('users.create'), async (req, res) => {
  const actor = currentUser(req);
  const body = parse(createInput, req.body);
  if (body.consoleAccess && !body.username) throw badRequest('برای دسترسی کنسول نام کاربری لازم است');
  if (body.roles.length && !actor.access.permissions.has('users.assign_roles')) throw forbidden('مجوز تخصیص نقش ندارید');
  if (await one('SELECT 1 FROM users WHERE national_code = $1', [body.nationalCode])) throw conflict('کاربری با این کد ملی قبلاً تعریف شده است');
  if (body.username && (await one('SELECT 1 FROM users WHERE username = $1', [body.username]))) throw conflict('نام کاربری تکراری است');
  if (body.districtId && !(await one('SELECT 1 FROM districts WHERE id = $1', [body.districtId]))) throw badRequest('منطقه نامعتبر است');

  try {
    await requireShahkarMatch({ nationalCode: body.nationalCode, mobile: body.mobile, context: 'console_user_create', requestedBy: actor.id });
  } catch (e) {
    await auditReq(req, { action: 'user.create', outcome: 'failure', details: { reason: (e as { code?: string }).code ?? 'error', nationalCode: maskNationalCode(body.nationalCode) } });
    throw e;
  }

  const tempPassword = body.consoleAccess ? temporaryPassword() : null;
  const user = await tx(async (db) => {
    const u = await one<{ id: string }>(
      `INSERT INTO users (national_code, mobile, first_name, last_name, kind, organization, position_title, district_id,
                          username, console_access, app_access, shahkar_verified_at, created_by)
       VALUES ($1,$2,$3,$4,'staff',$5,$6,$7,$8,$9,$10,now(),$11) RETURNING id`,
      [body.nationalCode, body.mobile, body.firstName, body.lastName, body.organization ?? null, body.positionTitle ?? null,
        body.districtId ?? null, body.username ?? null, body.consoleAccess, body.appAccess, actor.id],
      db,
    );
    if (tempPassword) await setPassword(db, u!.id, tempPassword, true);
    if (body.roles.length) await setUserRoles(db, actor.id, { id: u!.id, kind: 'staff' }, body.roles);
    await auditReq(req, { action: 'user.create', targetType: 'user', targetId: u!.id, details: { roles: body.roles.map((r) => r.key), consoleAccess: body.consoleAccess, shahkar: 'matched' } }, db);
    return u!;
  });
  res.status(201).json({ user: await loadUser(user.id), temporaryPassword: tempPassword });
});

const updateInput = z.object({
  mobile: mobile.optional(),
  firstName: z.string().trim().min(2).max(50).optional(),
  lastName: z.string().trim().min(2).max(50).optional(),
  organization: z.string().trim().max(100).nullish(),
  positionTitle: z.string().trim().max(100).nullish(),
  districtId: z.number().int().positive().nullish(),
  consoleAccess: z.boolean().optional(),
  appAccess: z.boolean().optional(),
  username: username.optional(),
});

usersRouter.patch('/:id', requirePermission('users.update'), async (req, res) => {
  const actor = currentUser(req);
  const target = await loadUser(req.params.id as string);
  const body = parse(updateInput, req.body);
  if (target.id === actor.id && (body.consoleAccess === false || body.mobile)) throw forbidden('این تغییر روی حساب خودتان مجاز نیست');
  if (body.consoleAccess && !(body.username ?? target.username)) throw badRequest('برای دسترسی کنسول نام کاربری لازم است');
  if (body.username && body.username !== target.username && (await one('SELECT 1 FROM users WHERE username = $1', [body.username]))) throw conflict('نام کاربری تکراری است');

  const mobileChanged = body.mobile && body.mobile !== target.mobile;
  if (mobileChanged) {
    // A new mobile becomes the second factor: it must belong to the same person.
    await requireShahkarMatch({ nationalCode: target.national_code, mobile: body.mobile!, context: 'console_user_update', userId: target.id, requestedBy: actor.id });
  }

  let tempPassword: string | null = null;
  await tx(async (db) => {
    await db.query(
      `UPDATE users SET
         mobile = COALESCE($2, mobile), first_name = COALESCE($3, first_name), last_name = COALESCE($4, last_name),
         organization = CASE WHEN $5 THEN $6 ELSE organization END,
         position_title = CASE WHEN $7 THEN $8 ELSE position_title END,
         district_id = CASE WHEN $9 THEN $10::int ELSE district_id END,
         console_access = COALESCE($11, console_access), app_access = COALESCE($12, app_access),
         username = COALESCE($13, username),
         shahkar_verified_at = CASE WHEN $14 THEN now() ELSE shahkar_verified_at END,
         app_enrolled_at = CASE WHEN $14 THEN NULL ELSE app_enrolled_at END,
         updated_at = now()
       WHERE id = $1`,
      [target.id, body.mobile ?? null, body.firstName ?? null, body.lastName ?? null,
        body.organization !== undefined, body.organization ?? null, body.positionTitle !== undefined, body.positionTitle ?? null,
        body.districtId !== undefined, body.districtId ?? null, body.consoleAccess ?? null, body.appAccess ?? null,
        body.username ?? null, !!mobileChanged],
    );
    if (mobileChanged) {
      // App must go through Shahkar + OTP again on the new SIM.
      await revokeUserSessions(db, target.id, 'mobile_change');
      await db.query('UPDATE user_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
    }
    if (body.consoleAccess === false) await revokeUserSessions(db, target.id, 'console_access_removed', 'console');
    if (body.appAccess === false) await revokeUserSessions(db, target.id, 'app_access_removed', 'app');
    if (body.consoleAccess && !target.console_access && !(await one('SELECT 1 FROM users WHERE id = $1 AND password_hash IS NOT NULL', [target.id], db))) {
      tempPassword = temporaryPassword();
      await setPassword(db, target.id, tempPassword, true);
    }
    await auditReq(req, { action: 'user.update', targetType: 'user', targetId: target.id, details: { fields: Object.keys(body), mobileChanged: !!mobileChanged } }, db);
  });
  res.json({ user: await loadUser(target.id), temporaryPassword: tempPassword });
});

usersRouter.put('/:id/roles', requirePermission('users.assign_roles'), async (req, res) => {
  const actor = currentUser(req);
  const target = await loadUser(req.params.id as string);
  const body = parse(z.object({ roles: roleGrants }), req.body);
  const changes = await tx(async (db) => {
    const r = await setUserRoles(db, actor.id, { id: target.id, kind: target.kind }, body.roles);
    await auditReq(req, { action: 'user.roles', targetType: 'user', targetId: target.id, details: r }, db);
    return r;
  });
  res.json({ user: await loadUser(target.id), ...changes });
});

usersRouter.post('/:id/status', requirePermission('users.status'), async (req, res) => {
  const actor = currentUser(req);
  const target = await loadUser(req.params.id as string);
  const body = parse(z.object({ status: z.enum(['active', 'suspended', 'disabled']), reason: z.string().trim().min(3).max(300) }), req.body);
  if (target.id === actor.id) throw forbidden('تغییر وضعیت حساب خودتان مجاز نیست');
  await tx(async (db) => {
    if (body.status !== 'active' && (target.roles as { key: string }[]).some((r) => r.key === 'security_admin')) await assertAnotherSecurityAdmin(db, target.id);
    await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [target.id, body.status]);
    if (body.status !== 'active') await revokeUserSessions(db, target.id, `status_${body.status}`);
    await auditReq(req, { action: 'user.status', targetType: 'user', targetId: target.id, details: { from: target.status, to: body.status, reason: body.reason } }, db);
  });
  res.json(await loadUser(target.id));
});

usersRouter.post('/:id/unlock', requirePermission('users.status'), async (req, res) => {
  const target = await loadUser(req.params.id as string);
  await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [target.id]);
  await auditReq(req, { action: 'user.unlock', targetType: 'user', targetId: target.id });
  res.json(await loadUser(target.id));
});

usersRouter.post('/:id/reset-password', requirePermission('users.status'), async (req, res) => {
  const actor = currentUser(req);
  const target = await loadUser(req.params.id as string);
  if (target.id === actor.id) throw forbidden('برای حساب خودتان از «تغییر رمز» استفاده کنید');
  if (!target.console_access) throw badRequest('این کاربر دسترسی کنسول ندارد');
  const pw = temporaryPassword();
  await tx(async (db) => {
    await setPassword(db, target.id, pw, true);
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [target.id]);
    await revokeUserSessions(db, target.id, 'password_reset', 'console');
    await auditReq(req, { action: 'user.password_reset', targetType: 'user', targetId: target.id }, db);
  });
  res.json({ temporaryPassword: pw });
});

/** Re-run Shahkar for an existing user (e.g. on suspicion of SIM change). Mismatch suspends the account. */
usersRouter.post('/:id/shahkar', requirePermission('shahkar.inquire'), async (req, res) => {
  const actor = currentUser(req);
  const target = await loadUser(req.params.id as string);
  const r = await inquireShahkar({ nationalCode: target.national_code, mobile: target.mobile, context: 'console_reverify', userId: target.id, requestedBy: actor.id });
  if (r.matched) {
    await pool.query('UPDATE users SET shahkar_verified_at = now() WHERE id = $1', [target.id]);
  } else if (target.id !== actor.id) {
    await tx(async (db) => {
      await db.query(`UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1`, [target.id]);
      await revokeUserSessions(db, target.id, 'shahkar_mismatch');
    });
  }
  await auditReq(req, { action: 'user.shahkar_reverify', targetType: 'user', targetId: target.id, outcome: r.matched ? 'success' : 'failure' });
  res.json({ matched: r.matched, user: await loadUser(target.id) });
});

usersRouter.get('/:id/sessions', requirePermission('sessions.manage'), async (req, res) => {
  const target = await loadUser(req.params.id as string);
  res.json(
    await query(
      `SELECT id, channel, device_id, device_name, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at, revoked_reason
         FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [target.id],
    ),
  );
});

usersRouter.delete('/:id/sessions/:sid', requirePermission('sessions.manage'), async (req, res) => {
  const target = await loadUser(req.params.id as string);
  const sid = req.params.sid as string;
  if (!/^[0-9a-f-]{36}$/.test(sid)) throw notFound();
  await revokeSession(pool, sid, 'admin_revoke');
  await auditReq(req, { action: 'session.revoke', targetType: 'session', targetId: sid, details: { userId: target.id } });
  res.status(204).end();
});

usersRouter.delete('/:id/sessions', requirePermission('sessions.manage'), async (req, res) => {
  const target = await loadUser(req.params.id as string);
  await revokeUserSessions(pool, target.id, 'admin_revoke_all');
  await auditReq(req, { action: 'session.revoke_all', targetType: 'user', targetId: target.id });
  res.status(204).end();
});
