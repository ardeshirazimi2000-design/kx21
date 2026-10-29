// Roles and permissions for staff. Base roles stay patient / doctor / operator / admin; staff
// (admin, operator) can additionally be given a "staff role" — a named set of permissions
// defined by a super administrator (an admin without a staff role has every permission).
// Also: user management (list, disable/enable, assign staff roles).
import { badRequest, conflict, forbidden, notFound, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson, isUniqueViolation } from '../lib/db.js';
import { requireUser } from './auth.js';

export const PERMISSIONS = {
  'doctors.review': 'بررسی و تأیید مدارک پزشکان',
  'tariffs.manage': 'تعرفه‌ها، کمیسیون و تنظیمات پرداخت',
  'payments.view': 'مشاهده پرداخت‌ها',
  'accounting.view': 'مشاهده حسابداری',
  'accounting.payout': 'ثبت تسویه با پزشکان',
  'drug_catalog.manage': 'مدیریت فهرست رسمی داروها',
  'escalations.handle': 'رسیدگی به ارجاع‌ها و اورژانس‌ها',
  'support.handle': 'پاسخگویی در دستیار پشتیبان (پشتیبانی و شکایات)',
  'support.report': 'گزارش عملکرد پشتیبانی و رضایت کاربران',
  'stats.view': 'مشاهده آمار',
  'audit.view': 'لاگ ممیزی',
  'activity.view': 'سابقه ورود و فعالیت کاربران',
  'mag.write': 'نوشتن و ویرایش مقالات مجله سلامت',
  'mag.publish': 'انتشار مقالات مجله سلامت (پس از تأیید پزشک)',
  'users.manage': 'مدیریت کاربران، نقش‌ها و دسترسی‌ها',
};
const ALL = Object.keys(PERMISSIONS);
const OPERATOR_DEFAULT = ['escalations.handle', 'support.handle', 'stats.view'];

export function createAccess({ db }) {
  function permissionsOf(userId) {
    const u = db.get('SELECT id, role, staff_role_id FROM users WHERE id = ?', userId);
    if (!u || !['admin', 'operator'].includes(u.role)) return { perms: [], superAdmin: false, staffRole: null };
    if (u.staff_role_id) {
      const r = db.get('SELECT * FROM staff_roles WHERE id = ?', u.staff_role_id);
      if (r) return { perms: parseJson(r.permissions, []).filter((p) => PERMISSIONS[p]), superAdmin: false, staffRole: { id: r.id, name: r.name } };
    }
    return u.role === 'admin' ? { perms: ALL, superAdmin: true, staffRole: null } : { perms: OPERATOR_DEFAULT, superAdmin: false, staffRole: null };
  }
  const can = (ctx, perm) => !!ctx.user && permissionsOf(ctx.user.sub).perms.includes(perm);
  function require(ctx, perm) {
    requireUser(ctx);
    if (!can(ctx, perm)) throw forbidden(`دسترسی «${PERMISSIONS[perm] ?? perm}» برای حساب شما تعریف نشده است`, 'permission_denied');
    return ctx.user;
  }
  return { permissionsOf, can, require };
}

export function register(router, { db, platform, domain }) {
  const access = domain.access;
  const superAdmins = (tenantId) => db.all(
    `SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' AND staff_role_id IS NULL AND deleted_at IS NULL AND disabled_at IS NULL`, tenantId,
  );

  router.get('/v1/admin/permissions', async (ctx) => {
    access.require(ctx, 'users.manage');
    return { body: { items: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })) } };
  });

  // ---- staff roles
  const roleView = (r) => ({
    id: r.id, name: r.name, permissions: parseJson(r.permissions, []), created_at: r.created_at,
    users: db.get('SELECT COUNT(*) AS n FROM users WHERE staff_role_id = ? AND deleted_at IS NULL', r.id).n,
  });
  const cleanRole = (b) => {
    const name = String(b.name ?? '').trim();
    if (name.length < 2 || name.length > 60) throw badRequest('نام نقش را وارد کنید');
    const perms = [...new Set(Array.isArray(b.permissions) ? b.permissions : [])];
    const bad = perms.filter((p) => !PERMISSIONS[p]);
    if (bad.length) throw badRequest(`دسترسی نامعتبر: ${bad.join(', ')}`);
    if (!perms.length) throw badRequest('حداقل یک دسترسی انتخاب کنید');
    return { name, perms };
  };
  router.get('/v1/admin/roles', async (ctx) => {
    access.require(ctx, 'users.manage');
    return { body: { items: db.all('SELECT * FROM staff_roles WHERE tenant_id = ? ORDER BY name', ctx.tenantId).map(roleView) } };
  });
  router.post('/v1/admin/roles', async (ctx) => {
    access.require(ctx, 'users.manage');
    const c = cleanRole(ctx.body);
    const id = uuid();
    try {
      db.run('INSERT INTO staff_roles (id, tenant_id, name, permissions, created_at) VALUES (?,?,?,?,?)', id, ctx.tenantId, c.name, JSON.stringify(c.perms), nowIso());
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('نقشی با این نام وجود دارد', 'duplicate');
      throw e;
    }
    platform.audit(ctx, 'role.create', `role:${id}`, { name: c.name, permissions: c.perms });
    return { status: 201, body: roleView(db.get('SELECT * FROM staff_roles WHERE id = ?', id)) };
  });
  router.put('/v1/admin/roles/:id', async (ctx) => {
    access.require(ctx, 'users.manage');
    const r = db.get('SELECT * FROM staff_roles WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!r) throw notFound('نقش');
    const c = cleanRole({ name: r.name, permissions: parseJson(r.permissions, []), ...ctx.body });
    db.run('UPDATE staff_roles SET name = ?, permissions = ? WHERE id = ?', c.name, JSON.stringify(c.perms), r.id);
    platform.audit(ctx, 'role.update', `role:${r.id}`, { name: c.name, permissions: c.perms });
    return { body: roleView(db.get('SELECT * FROM staff_roles WHERE id = ?', r.id)) };
  });
  router.delete('/v1/admin/roles/:id', async (ctx) => {
    access.require(ctx, 'users.manage');
    const r = db.get('SELECT * FROM staff_roles WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!r) throw notFound('نقش');
    if (roleView(r).users) throw conflict('این نقش به کاربرانی داده شده است؛ ابتدا نقش آن‌ها را تغییر دهید', 'role_in_use');
    db.run('DELETE FROM staff_roles WHERE id = ?', r.id);
    platform.audit(ctx, 'role.delete', `role:${r.id}`, { name: r.name });
    return { status: 204 };
  });

  // ---- users
  const userView = (u) => {
    const p = access.permissionsOf(u.id);
    const last = db.get('SELECT at, ip FROM login_events WHERE user_id = ? AND success = 1 ORDER BY at DESC LIMIT 1', u.id);
    return {
      id: u.id, role: u.role, full_name: u.full_name, phone: u.phone, email: u.email, created_at: u.created_at,
      disabled: !!u.disabled_at, disabled_at: u.disabled_at, staff_role: p.staffRole, super_admin: p.superAdmin,
      last_login_at: last?.at ?? null, last_login_ip: last?.ip ?? null,
    };
  };
  const loadUser = (ctx, id) => {
    const u = db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', requireUuid(id, 'id'), ctx.tenantId);
    if (!u) throw notFound('کاربر');
    return u;
  };

  router.get('/v1/admin/users', async (ctx) => {
    access.require(ctx, 'users.manage');
    const role = ['patient', 'doctor', 'operator', 'admin'].includes(ctx.query.role) ? ctx.query.role : null;
    const q = String(ctx.query.q ?? '').trim().slice(0, 40);
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const where = ['tenant_id = ?', 'deleted_at IS NULL'];
    const args = [ctx.tenantId];
    if (role) { where.push('role = ?'); args.push(role); }
    if (q) { where.push('(phone LIKE ? OR full_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const total = db.get(`SELECT COUNT(*) AS n FROM users WHERE ${where.join(' AND ')}`, ...args).n;
    const rows = db.all(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 50 OFFSET ?`, ...args, (page - 1) * 50);
    return { body: { total, page, items: rows.map(userView) } };
  });

  router.get('/v1/admin/users/:id', async (ctx) => {
    access.require(ctx, 'users.manage');
    const u = loadUser(ctx, ctx.params.id);
    return { body: { ...userView(u), permissions: access.permissionsOf(u.id).perms } };
  });

  // Assign (or clear, → full admin / default operator) a staff role.
  router.put('/v1/admin/users/:id/staff-role', async (ctx) => {
    access.require(ctx, 'users.manage');
    const u = loadUser(ctx, ctx.params.id);
    if (!['admin', 'operator'].includes(u.role)) throw badRequest('نقش سازمانی فقط برای کادر (مدیر/اپراتور) قابل تعریف است');
    const rid = ctx.body.staff_role_id ? requireUuid(ctx.body.staff_role_id, 'staff_role_id') : null;
    if (rid && !db.get('SELECT 1 FROM staff_roles WHERE id = ? AND tenant_id = ?', rid, ctx.tenantId)) throw notFound('نقش');
    // Never leave the clinic without a super administrator.
    const supers = superAdmins(ctx.tenantId).map((x) => x.id);
    if (rid && supers.length === 1 && supers[0] === u.id) throw conflict('حداقل یک مدیر کل (با همه دسترسی‌ها) باید باقی بماند', 'last_super_admin');
    db.run('UPDATE users SET staff_role_id = ? WHERE id = ?', rid, u.id);
    platform.audit(ctx, 'user.staff_role', `user:${u.id}`, { staff_role_id: rid });
    return { body: userView(db.get('SELECT * FROM users WHERE id = ?', u.id)) };
  });

  // A person who registered as a patient becomes staff (e.g. a support agent) on the same number.
  // Their patient history stays in the system; with the new role they use the staff side only.
  router.post('/v1/admin/users/:id/convert-to-staff', async (ctx) => {
    access.require(ctx, 'users.manage');
    const u = loadUser(ctx, ctx.params.id);
    if (u.role !== 'patient') throw conflict('فقط حساب بیمار قابل تبدیل به کادر است', 'not_patient');
    const role = ctx.body.role === 'admin' ? 'admin' : 'operator';
    const rid = ctx.body.staff_role_id ? requireUuid(ctx.body.staff_role_id, 'staff_role_id') : null;
    if (rid && !db.get('SELECT 1 FROM staff_roles WHERE id = ? AND tenant_id = ?', rid, ctx.tenantId)) throw notFound('نقش');
    const p = db.get('SELECT id FROM patients WHERE user_id = ?', u.id);
    const history = p ? {
      appointments: db.get('SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ?', p.id).n,
      records: db.get('SELECT COUNT(*) AS n FROM medical_records WHERE patient_id = ?', p.id).n,
    } : { appointments: 0, records: 0 };
    if ((history.appointments || history.records) && ctx.body.confirm !== true) {
      throw conflict(`این بیمار ${history.appointments} نوبت و ${history.records} مدرک پزشکی دارد. پس از تبدیل، با این شماره دیگر نمی‌تواند به‌عنوان بیمار از سامانه استفاده کند (سوابق حذف نمی‌شود). برای ادامه تأیید کنید.`, 'patient_has_history');
    }
    db.run('UPDATE users SET role = ?, staff_role_id = ? WHERE id = ?', role, rid, u.id);
    platform.audit(ctx, 'user.convert_to_staff', `user:${u.id}`, { from: 'patient', to: role, staff_role_id: rid, history });
    platform.notify(ctx, { userId: u.id, channel: 'sms', target: u.phone, body: 'حساب شما در درمان پلاس به حساب کادر تبدیل شد. از گزینه «ثبت‌نام و ورود پزشکان» وارد شوید.' });
    return { body: userView(db.get('SELECT * FROM users WHERE id = ?', u.id)) };
  });

  for (const [path, disable] of [['disable', true], ['enable', false]]) {
    router.post(`/v1/admin/users/:id/${path}`, async (ctx) => {
      access.require(ctx, 'users.manage');
      const u = loadUser(ctx, ctx.params.id);
      if (disable) {
        if (u.id === ctx.user.sub) throw conflict('نمی‌توانید حساب خودتان را غیرفعال کنید', 'self');
        const supers = superAdmins(ctx.tenantId).map((x) => x.id);
        if (supers.length === 1 && supers[0] === u.id) throw conflict('آخرین مدیر کل قابل غیرفعال‌سازی نیست', 'last_super_admin');
        const reason = String(ctx.body?.reason ?? '').trim().slice(0, 300) || null;
        db.run('UPDATE users SET disabled_at = ?, disabled_reason = ? WHERE id = ?', nowIso(), reason, u.id);
        // A disabled doctor disappears from the directory and cannot receive bookings.
        db.run(`UPDATE doctors SET status = 'suspended' WHERE user_id = ? AND status = 'approved'`, u.id);
      } else {
        db.run('UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = ?', u.id);
        db.run(`UPDATE doctors SET status = 'approved' WHERE user_id = ? AND status = 'suspended'`, u.id);
      }
      platform.audit(ctx, disable ? 'user.disable' : 'user.enable', `user:${u.id}`, disable ? { reason: ctx.body?.reason ?? null } : undefined);
      return { body: userView(db.get('SELECT * FROM users WHERE id = ?', u.id)) };
    });
  }
}

// Login history and activity: every user sees their own; staff with activity.view see everyone's.
export function registerActivity(router, { db, domain }) {
  const loginView = (e) => ({ at: e.at, success: !!e.success, method: e.method, reason: e.reason, ip: e.ip, user_agent: e.user_agent, user_id: e.user_id, phone: e.phone });
  const actionView = (a) => ({ at: a.ts, action: a.action, resource: a.resource, ip: a.ip, actor_id: a.actor_id, detail: parseJson(a.detail, null) });
  const people = (ids) => new Map(ids.length
    ? db.all(`SELECT id, full_name, phone, role FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((u) => [u.id, u])
    : []);
  const window = (q) => ({
    from: /^\d{4}-\d{2}-\d{2}$/.test(String(q.from ?? '')) ? `${q.from}T00:00:00.000Z` : '0000',
    to: /^\d{4}-\d{2}-\d{2}$/.test(String(q.to ?? '')) ? `${q.to}T23:59:59.999Z` : '9999',
  });

  router.get('/v1/me/activity', async (ctx) => {
    requireUser(ctx);
    return {
      body: {
        logins: db.all('SELECT * FROM login_events WHERE user_id = ? ORDER BY at DESC LIMIT 50', ctx.user.sub).map(loginView),
        actions: db.all('SELECT * FROM audit_logs WHERE actor_id = ? ORDER BY id DESC LIMIT 100', ctx.user.sub).map(actionView),
      },
    };
  });

  router.get('/v1/admin/activity', async (ctx) => {
    domain.access.require(ctx, 'activity.view');
    const { from, to } = window(ctx.query);
    const uid = ctx.query.user_id ? requireUuid(ctx.query.user_id, 'user_id') : null;
    const kind = ctx.query.kind === 'actions' ? 'actions' : 'logins';
    const limit = 200;
    let items;
    if (kind === 'logins') {
      const fail = ctx.query.failed === '1' ? 'AND success = 0' : '';
      items = db.all(`SELECT * FROM login_events WHERE tenant_id = ? AND at >= ? AND at <= ? ${uid ? 'AND user_id = ?' : ''} ${fail} ORDER BY at DESC LIMIT ${limit}`,
        ctx.tenantId, from, to, ...(uid ? [uid] : [])).map(loginView);
      const who = people([...new Set(items.map((x) => x.user_id).filter(Boolean))]);
      items = items.map((x) => ({ ...x, user: who.get(x.user_id) ?? null }));
    } else {
      const action = String(ctx.query.action ?? '').replace(/[^a-z_.]/g, '').slice(0, 40);
      items = db.all(`SELECT * FROM audit_logs WHERE tenant_id = ? AND ts >= ? AND ts <= ? ${uid ? 'AND actor_id = ?' : ''} ${action ? 'AND action LIKE ?' : ''} ORDER BY id DESC LIMIT ${limit}`,
        ctx.tenantId, from, to, ...(uid ? [uid] : []), ...(action ? [`${action}%`] : [])).map(actionView);
      const who = people([...new Set(items.map((x) => x.actor_id).filter(Boolean))]);
      items = items.map((x) => ({ ...x, user: who.get(x.actor_id) ?? null }));
    }
    const summary = db.get(
      `SELECT SUM(success) AS ok, SUM(1 - success) AS failed, COUNT(DISTINCT user_id) AS users FROM login_events WHERE tenant_id = ? AND at >= ? AND at <= ?`,
      ctx.tenantId, from, to,
    );
    return { body: { kind, items, summary: { successful_logins: summary.ok ?? 0, failed_logins: summary.failed ?? 0, users: summary.users ?? 0 } } };
  });
}
