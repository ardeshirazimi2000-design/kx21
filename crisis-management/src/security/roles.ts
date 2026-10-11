import { pool, query, type Db } from '../db/pool.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import {
  BUILTIN_ROLES,
  MUTUALLY_EXCLUSIVE_ROLES,
  PERMISSIONS,
  SCOPE_RANK,
  type Scope,
} from './catalog.js';

export type Channel = 'console' | 'app';

export interface Access {
  roles: { key: string; title: string; scope: Scope; expiresAt: string | null }[];
  permissions: Set<string>;
  /** Widest data scope granted for each permission. */
  scopes: Map<string, Scope>;
}

/** Inserts/refreshes the built-in roles. Locked roles are always reset to the catalogue. */
export async function syncBuiltinRoles(db: Db = pool): Promise<void> {
  for (const r of BUILTIN_ROLES) {
    const existing = await query<{ key: string }>('SELECT key FROM roles WHERE key = $1', [r.key], db);
    if (existing.length === 0) {
      await db.query(
        `INSERT INTO roles (key, title, description, scope, builtin, locked, staff_only) VALUES ($1,$2,$3,$4,true,$5,$6)`,
        [r.key, r.title, r.description, r.scope, r.locked, r.staffOnly],
      );
      for (const p of r.permissions) await db.query('INSERT INTO role_permissions (role_key, permission) VALUES ($1,$2)', [r.key, p]);
    } else if (r.locked) {
      await db.query('UPDATE roles SET title=$2, description=$3, scope=$4, locked=true, staff_only=$5 WHERE key=$1', [r.key, r.title, r.description, r.scope, r.staffOnly]);
      await db.query('DELETE FROM role_permissions WHERE role_key = $1', [r.key]);
      for (const p of r.permissions) await db.query('INSERT INTO role_permissions (role_key, permission) VALUES ($1,$2)', [r.key, p]);
    }
  }
}

const APP_BLOCKED_GROUPS = new Set(['identity', 'security']);
const APP_BLOCKED = new Set(PERMISSIONS.filter((p) => APP_BLOCKED_GROUPS.has(p.group)).map((p) => p.key));

/**
 * Effective access of a user: union of permissions of their unexpired roles.
 * On the app channel, identity/security administration permissions are never effective.
 */
export async function loadAccess(userId: string, channel: Channel | null, db: Db = pool): Promise<Access> {
  const rows = await query<{ key: string; title: string; scope: Scope; expires_at: string | null; permission: string | null }>(
    `SELECT r.key, r.title, r.scope, ur.expires_at, rp.permission
       FROM user_roles ur
       JOIN roles r ON r.key = ur.role_key
       LEFT JOIN role_permissions rp ON rp.role_key = r.key
      WHERE ur.user_id = $1 AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [userId],
    db,
  );
  const roles = new Map<string, Access['roles'][number]>();
  const permissions = new Set<string>();
  const scopes = new Map<string, Scope>();
  for (const r of rows) {
    if (!roles.has(r.key)) roles.set(r.key, { key: r.key, title: r.title, scope: r.scope, expiresAt: r.expires_at });
    if (!r.permission) continue;
    if (channel === 'app' && APP_BLOCKED.has(r.permission)) continue;
    permissions.add(r.permission);
    const prev = scopes.get(r.permission);
    if (!prev || SCOPE_RANK[r.scope] > SCOPE_RANK[prev]) scopes.set(r.permission, r.scope);
  }
  return { roles: [...roles.values()], permissions, scopes };
}

export interface RoleGrant {
  key: string;
  expiresAt?: string | null;
}

/**
 * Replaces the roles of `targetId`, enforcing:
 *  - nobody changes their own roles;
 *  - roles exist, and staff-only roles go to staff accounts;
 *  - separation of duties (mutually exclusive roles);
 *  - at least one active security administrator always remains.
 */
export async function setUserRoles(
  db: Db,
  actorId: string,
  target: { id: string; kind: string },
  grants: RoleGrant[],
): Promise<{ added: string[]; removed: string[] }> {
  if (actorId === target.id) throw forbidden('تغییر نقش‌های خودتان مجاز نیست');
  const keys = [...new Set(grants.map((g) => g.key))];
  const defs = await query<{ key: string; staff_only: boolean }>('SELECT key, staff_only FROM roles WHERE key = ANY($1)', [keys], db);
  const missing = keys.filter((k) => !defs.find((d) => d.key === k));
  if (missing.length) throw badRequest(`نقش تعریف نشده: ${missing.join('، ')}`);
  if (target.kind !== 'staff') {
    const staffOnly = defs.filter((d) => d.staff_only).map((d) => d.key);
    if (staffOnly.length) throw badRequest(`این نقش‌ها فقط به کارکنان قابل تخصیص است: ${staffOnly.join('، ')}`);
  }
  for (const [a, b] of MUTUALLY_EXCLUSIVE_ROLES) {
    if (keys.includes(a) && keys.includes(b)) throw conflict(`تفکیک وظایف: نقش‌های «${a}» و «${b}» همزمان قابل تخصیص نیستند`);
  }
  for (const g of grants) {
    if (g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now()) throw badRequest('تاریخ انقضای نقش باید در آینده باشد');
  }

  const current = (await query<{ role_key: string }>('SELECT role_key FROM user_roles WHERE user_id = $1', [target.id], db)).map((r) => r.role_key);
  const removed = current.filter((k) => !keys.includes(k));
  const added = keys.filter((k) => !current.includes(k));

  if (removed.includes('security_admin')) await assertAnotherSecurityAdmin(db, target.id);

  await db.query('DELETE FROM user_roles WHERE user_id = $1', [target.id]);
  for (const g of grants) {
    await db.query(
      `INSERT INTO user_roles (user_id, role_key, granted_by, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [target.id, g.key, actorId, g.expiresAt ?? null],
    );
  }
  return { added, removed };
}

/** Throws unless an active security administrator other than `exceptUserId` exists. */
export async function assertAnotherSecurityAdmin(db: Db, exceptUserId: string): Promise<void> {
  const others = await query(
    `SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE ur.role_key = 'security_admin' AND ur.user_id <> $1 AND u.status = 'active'
        AND (ur.expires_at IS NULL OR ur.expires_at > now()) LIMIT 1`,
    [exceptUserId],
    db,
  );
  if (others.length === 0) throw conflict('حداقل یک «مدیر امنیت و کاربران» فعال باید در سامانه باقی بماند');
}
