import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { query, type Db, pool } from "../db/pool.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { Permission } from "../services/permissions.js";
import { verifyToken } from "./tokens.js";

export interface UserPosition {
  positionId: string;
  title: string;
  unitId: string;
  unitName: string;
  isManager: boolean;
  isPrimary: boolean;
}

export interface AuthUser {
  id: string;
  fullName: string;
  clearance: number;
  mfaEnabled: boolean;
  roles: string[];
  positions: UserPosition[];
  /** permission → 'all' or the unit ids (subtrees expanded) where it applies */
  perms: Map<string, "all" | Set<string>>;
  /** Units the user manages (head of unit), with sub-units. */
  managedUnits: Set<string>;
  can(p: Permission, unitId?: string | null): boolean;
  /** Units where the permission applies; null = everywhere. */
  unitsFor(p: Permission): string[] | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Descendants (inclusive) of the given units. */
export async function unitSubtree(
  unitIds: string[],
  db: Db = pool,
): Promise<string[]> {
  if (!unitIds.length) return [];
  const rows = await query<{ id: string }>(
    `WITH RECURSIVE t AS (SELECT id FROM org_units WHERE id = ANY($1::uuid[])
       UNION SELECT u.id FROM org_units u JOIN t ON u.parent_id = t.id) SELECT id FROM t`,
    [unitIds],
    db,
  );
  return rows.map((r) => r.id);
}

export async function loadAuthUser(
  userId: string,
  db: Db = pool,
): Promise<AuthUser | null> {
  const [u] = await query(
    "SELECT id, full_name, clearance, is_active, mfa_enabled FROM users WHERE id = $1",
    [userId],
    db,
  );
  if (!u || !u.is_active) return null;
  // Sequential: db may be a single transaction client.
  const grants = await query<{
    key: string;
    role_key: string;
    scope_unit_id: string | null;
  }>(
    `SELECT rp.permission_key AS key, r.key AS role_key, ur.scope_unit_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE ur.user_id = $1`,
    [userId],
    db,
  );
  const positions = await query(
    `SELECT p.id AS position_id, p.title, p.unit_id, ou.name AS unit_name, p.is_manager, up.is_primary
         FROM user_positions up JOIN positions p ON p.id = up.position_id JOIN org_units ou ON ou.id = p.unit_id
        WHERE up.user_id = $1 AND (up.end_date IS NULL OR up.end_date >= current_date) ORDER BY up.is_primary DESC`,
    [userId],
    db,
  );
  const scopes = [
    ...new Set(grants.map((g) => g.scope_unit_id).filter(Boolean)),
  ] as string[];
  const subtrees = new Map<string, string[]>();
  for (const s of scopes) subtrees.set(s, await unitSubtree([s], db));
  const perms = new Map<string, "all" | Set<string>>();
  for (const g of grants) {
    if (!g.key) continue;
    const cur = perms.get(g.key);
    if (cur === "all") continue;
    if (!g.scope_unit_id) perms.set(g.key, "all");
    else {
      const set = cur ?? new Set<string>();
      subtrees.get(g.scope_unit_id)!.forEach((id) => set.add(id));
      perms.set(g.key, set);
    }
  }
  const managedUnits = new Set(
    await unitSubtree(
      positions.filter((p) => p.is_manager).map((p) => p.unit_id),
      db,
    ),
  );
  const user: AuthUser = {
    id: u.id,
    fullName: u.full_name,
    clearance: u.clearance,
    mfaEnabled: u.mfa_enabled,
    roles: [...new Set(grants.map((g) => g.role_key))],
    positions: positions.map((p) => ({
      positionId: p.position_id,
      title: p.title,
      unitId: p.unit_id,
      unitName: p.unit_name,
      isManager: p.is_manager,
      isPrimary: p.is_primary,
    })),
    perms,
    managedUnits,
    can(p, unitId) {
      const v = perms.get(p);
      if (!v) return false;
      if (v === "all") return true;
      return unitId ? v.has(unitId) : v.size > 0;
    },
    unitsFor(p) {
      const v = perms.get(p);
      if (v === "all") return null;
      return v ? [...v] : [];
    },
  };
  return user;
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw unauthorized();
  const payload = verifyToken(token, "access");
  if (!payload) throw unauthorized("توکن نامعتبر یا منقضی است");
  const user = await loadAuthUser(payload.sub);
  if (!user) throw unauthorized("حساب کاربری غیرفعال است");
  // Roles that must use 2FA can only reach their profile (to enable it) until they do.
  if (
    !user.mfaEnabled &&
    user.roles.some((r) => config.mfaRequiredRoles.includes(r)) &&
    !req.originalUrl.startsWith("/api/auth/")
  ) {
    throw forbidden("برای این نقش، فعال‌سازی ورود دومرحله‌ای الزامی است");
  }
  req.user = user;
  next();
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requirePerm(
  u: AuthUser,
  p: Permission,
  unitId?: string | null,
) {
  if (!u.can(p, unitId)) throw forbidden();
}
