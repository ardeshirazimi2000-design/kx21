import type { AuthUser } from '../auth/middleware.js';
import { one, query, type Db, pool } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Letter visibility (RBAC + ABAC), appended to `params`:
 *  - direct participants: creator, routing sender/receiver (user or position), workflow assignees,
 *    internal recipients (user/position/unit) once the letter left draft;
 *  - organisational access: `letter.read_all` in the letter's unit scope or head of that unit.
 * Every path is limited by confidentiality ≤ the user's clearance: being a participant never overrides it.
 */
export function letterVisibleSql(u: AuthUser, params: unknown[], alias = 'l'): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const me = p(u.id);
  const positions = p(u.positions.map((x) => x.positionId));
  const units = p([...new Set(u.positions.map((x) => x.unitId))]);
  const readAll = u.unitsFor('letter.read_all');
  const orgUnits = p([...new Set([...(readAll ?? []), ...u.managedUnits])]);
  const all = p(readAll === null);
  const clearance = p(u.clearance);
  return `(${alias}.confidentiality <= ${clearance} AND (
    ${alias}.created_by = ${me}
    OR EXISTS (SELECT 1 FROM letter_routing r WHERE r.letter_id = ${alias}.id
               AND (r.from_user_id = ${me} OR r.to_user_id = ${me} OR r.to_position_id = ANY(${positions}::uuid[])))
    OR EXISTS (SELECT 1 FROM workflow_steps ws JOIN workflow_instances wi ON wi.id = ws.instance_id WHERE wi.letter_id = ${alias}.id
               AND (ws.assignee_user_id = ${me} OR ws.assignee_position_id = ANY(${positions}::uuid[])))
    OR (${alias}.status <> 'draft' AND EXISTS (SELECT 1 FROM letter_recipients lr WHERE lr.letter_id = ${alias}.id
               AND (lr.user_id = ${me} OR lr.position_id = ANY(${positions}::uuid[]) OR lr.unit_id = ANY(${units}::uuid[]))))
    OR ${all}::boolean OR ${alias}.owner_unit_id = ANY(${orgUnits}::uuid[])
  ))`;
}

export async function loadVisibleLetter(u: AuthUser, id: string, db: Db = pool, lock = false) {
  const params: unknown[] = [id];
  const l = await one(`SELECT l.* FROM letters l WHERE l.id = $1 AND ${letterVisibleSql(u, params)}${lock ? ' FOR UPDATE OF l' : ''}`, params, db);
  // 404 (not 403) so the existence of a letter is not disclosed.
  if (!l) throw notFound('نامه یافت نشد');
  return l;
}

/** Archive visibility: archive.read in the folder's unit scope (or global), and clearance. */
export function documentVisibleSql(u: AuthUser, params: unknown[], alias = 'd', folderAlias = 'f'): string {
  const scope = u.unitsFor('archive.read');
  const manage = u.unitsFor('archive.manage');
  params.push(scope === null || manage === null);
  const all = `$${params.length}`;
  params.push([...new Set([...(scope ?? []), ...(manage ?? []), ...u.managedUnits])]);
  const units = `$${params.length}`;
  params.push(u.clearance);
  const cl = `$${params.length}`;
  params.push(u.id);
  const me = `$${params.length}`;
  return `(${alias}.confidentiality <= ${cl} AND (${all}::boolean OR ${folderAlias}.unit_id = ANY(${units}::uuid[]) OR ${alias}.created_by = ${me}))`;
}

/**
 * Names of the people who would receive a letter of this confidentiality without the clearance to read it:
 * the users themselves, the current holders of the positions, and everybody holding a position in the units
 * (internal recipients by unit are visible to all of them).
 */
export async function unclearedNames(db: Db, level: number, t: { userIds?: string[]; positionIds?: string[]; unitIds?: string[] }): Promise<string[]> {
  if (level <= 0) return [];
  const rows = await query<{ full_name: string }>(
    `SELECT DISTINCT u.full_name FROM users u
      WHERE u.is_active AND u.clearance < $1 AND (
        u.id = ANY($2::uuid[])
        OR EXISTS (SELECT 1 FROM user_positions up JOIN positions p ON p.id = up.position_id
                    WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date)
                      AND (p.id = ANY($3::uuid[]) OR p.unit_id = ANY($4::uuid[]))))
      ORDER BY u.full_name`,
    [level, t.userIds ?? [], t.positionIds ?? [], t.unitIds ?? []],
    db,
  );
  return rows.map((r) => r.full_name);
}

/** Rejects (400) handing a letter to anybody without the clearance for its confidentiality. */
export async function requireCleared(db: Db, level: number, t: { userIds?: string[]; positionIds?: string[]; unitIds?: string[] }) {
  const names = await unclearedNames(db, level, t);
  if (names.length) throw badRequest(`صلاحیت دسترسی ${names.slice(0, 5).join('، ')} برای سطح محرمانگی این نامه کافی نیست`);
}
