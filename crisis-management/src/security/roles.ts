import { pool, query, type Db } from '../db/pool.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { BUILTIN_ROLES, PERMISSIONS, SCOPE_RANK, type Scope } from './catalog.js';

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
 * Sets the (single) role of `targetId` — PP FMT_SMR.1.2, application note 19: one role per account.
 * Enforces: nobody changes their own role; the role exists; staff-only roles go to staff accounts;
 * at least one active security administrator remains. A change ends the user's sessions (FIA_USB.1.3:
 * security attributes never change during an active session; the user signs in again).
 */
export async function setUserRole(
  db: Db,
  actorId: string,
  target: { id: string; kind: string },
  grant: RoleGrant | null,
): Promise<{ before: string | null; after: string | null }> {
  if (actorId === target.id) throw forbidden('تغییر نقش خودتان مجاز نیست');
  if (grant) {
    const def = await query<{ key: string; staff_only: boolean }>('SELECT key, staff_only FROM roles WHERE key = $1', [grant.key], db);
    if (def.length === 0) throw badRequest(`نقش تعریف نشده: ${grant.key}`);
    if (target.kind !== 'staff' && def[0].staff_only) throw badRequest(`نقش «${grant.key}» فقط به کارکنان قابل تخصیص است`);
    if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= Date.now()) throw badRequest('تاریخ انقضای نقش باید در آینده باشد');
  }
  const current = (await query<{ role_key: string; expires_at: string | null }>('SELECT role_key, expires_at FROM user_roles WHERE user_id = $1', [target.id], db))[0];
  const before = current?.role_key ?? null;
  const after = grant?.key ?? null;
  if (before === 'security_admin' && after !== 'security_admin') await assertAnotherSecurityAdmin(db, target.id);

  await db.query('DELETE FROM user_roles WHERE user_id = $1', [target.id]);
  if (grant) {
    await db.query('INSERT INTO user_roles (user_id, role_key, granted_by, expires_at) VALUES ($1,$2,$3,$4)', [target.id, grant.key, actorId, grant.expiresAt ?? null]);
  }
  if (before !== after || (current?.expires_at ?? null) !== (grant?.expiresAt ?? null)) {
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'role_changed' WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
  }
  return { before, after };
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
