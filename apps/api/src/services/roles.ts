import {
  BUILTIN_ROLES,
  CONFIGURABLE_CAPABILITIES,
  DEFAULT_ROLE_CAPABILITIES,
  positionHasVote,
  resolveCapabilities,
  roleLabel,
  type Capability,
  type RoleMatrix,
} from '@kx/shared';
import type { AuthUser } from '../auth/middleware.js';
import { pool, query, type Db } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export interface CustomRole {
  key: string;
  title: string;
  description: string | null;
  has_vote: boolean;
}

/** Built-in commission positions (chamber_admin and guest are not commission positions). */
const BUILTIN_POSITIONS = ['chair', 'vice_chair', 'secretary', 'member', 'expert', 'observer'];
const BUILTIN_MEETING_ROLES = [...BUILTIN_POSITIONS, 'guest'];

export async function loadRoleMatrix(chamberId: string, db: Db = pool): Promise<RoleMatrix> {
  const rows = await query<{ role_key: string; capabilities: string[] }>(
    'SELECT role_key, capabilities FROM role_permissions WHERE chamber_id = $1',
    [chamberId],
    db,
  );
  const m: RoleMatrix = {};
  for (const r of rows) m[r.role_key] = r.capabilities.filter((c) => (CONFIGURABLE_CAPABILITIES as readonly string[]).includes(c)) as Capability[];
  return m;
}

export async function customRoles(chamberId: string, db: Db = pool): Promise<CustomRole[]> {
  return query<CustomRole>('SELECT key, title, description, has_vote FROM custom_roles WHERE chamber_id = $1 ORDER BY title', [chamberId], db);
}

/** Throws 400 unless `key` is a valid commission position (kind=position) or meeting role (kind=meeting) in the chamber. */
export async function assertRole(chamberId: string, key: string, kind: 'position' | 'meeting', db: Db = pool): Promise<CustomRole | null> {
  const builtins = kind === 'position' ? BUILTIN_POSITIONS : BUILTIN_MEETING_ROLES;
  if (builtins.includes(key)) return null;
  const r = (await customRoles(chamberId, db)).find((x) => x.key === key);
  if (!r) throw badRequest('نقش انتخاب‌شده در این اتاق تعریف نشده است');
  return r;
}

export async function defaultHasVote(chamberId: string, key: string, db: Db = pool): Promise<boolean> {
  if (key === 'guest') return false;
  const custom = await assertRole(chamberId, key, 'meeting', db);
  return custom ? custom.has_vote : positionHasVote(key);
}

/**
 * Commission ids whose meetings/resolutions the user may browse (through its commission role).
 * Used by list/search queries that cannot evaluate the role matrix in SQL.
 */
export async function browsableCommissionIds(user: AuthUser, db: Db = pool): Promise<string[]> {
  const rows = await query<{ commission_id: string; chamber_id: string; position: string }>(
    `SELECT commission_id, chamber_id, position FROM commission_memberships WHERE user_id = $1 AND status = 'active'`,
    [user.id],
    db,
  );
  const matrices = new Map<string, RoleMatrix>();
  const out: string[] = [];
  for (const r of rows) {
    if (!matrices.has(r.chamber_id)) matrices.set(r.chamber_id, await loadRoleMatrix(r.chamber_id, db));
    const caps = resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false, position: r.position, roleMatrix: matrices.get(r.chamber_id) });
    if (caps.has('commission.browse')) out.push(r.commission_id);
  }
  return out;
}

/** Whether chamber admins of this chamber may browse commission content (role matrix of chamber_admin). */
export async function adminBrowsableChambers(user: AuthUser, db: Db = pool): Promise<string[]> {
  const out: string[] = [];
  for (const id of user.adminChambers) {
    const m = await loadRoleMatrix(id, db);
    if ((m.chamber_admin ?? DEFAULT_ROLE_CAPABILITIES.chamber_admin).includes('commission.browse')) out.push(id);
  }
  return out;
}

export function describeRoles(custom: CustomRole[], matrix: RoleMatrix) {
  const builtin = BUILTIN_ROLES.map((key) => ({
    key,
    title: roleLabel(key),
    builtin: true,
    kind: key === 'chamber_admin' ? 'chamber' : key === 'guest' ? 'meeting' : 'commission',
    has_vote: key === 'chamber_admin' || key === 'guest' ? false : positionHasVote(key),
    capabilities: matrix[key] ?? DEFAULT_ROLE_CAPABILITIES[key],
    customized: !!matrix[key],
    defaults: DEFAULT_ROLE_CAPABILITIES[key],
  }));
  const customList = custom.map((r) => ({
    key: r.key,
    title: r.title,
    description: r.description,
    builtin: false,
    kind: 'commission',
    has_vote: r.has_vote,
    capabilities: matrix[r.key] ?? [],
    customized: true,
    defaults: [] as string[],
  }));
  return [...builtin, ...customList];
}
