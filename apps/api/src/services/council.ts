import { toJalali, type CaseActor, type CaseLevel, type CaseStatus, type NotificationEvent } from '@kx/shared';
import type { AuthUser } from '../auth/middleware.js';
import { one, pool, query, type Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { commissionAccess } from './access.js';
import { notify } from './notifications.js';

/**
 * شورای گفت‌وگو: who sees a council case and who acts on it.
 *
 *  - the council's secretariat (position «secretary» in the council or its expert group) and the council's
 *    secretary (دبیر شورا, the chamber president) of the case's current level: every case of their level;
 *  - members of those bodies: the level's cases, a confidential one only once it was on the council's agenda;
 *  - the originating commission: its cases at every level (a confidential one: its secretariat only);
 *  - the chamber admin: their chamber's cases, to follow them (no action);
 *  - invitees of a meeting with the case on its agenda (e.g. government representatives in an expert meeting).
 * A case that may not be seen is «not found».
 */

export interface CouncilCase {
  id: string;
  code: string;
  title: string;
  description: string | null;
  origin_chamber_id: string;
  origin_commission_id: string | null;
  origin_resolution_id: string | null;
  level: CaseLevel;
  status: CaseStatus;
  priority: string;
  confidential: boolean;
  due_date: string | null;
  outcome: string | null;
  national_reached_at: Date | null;
  provincial_agenda_at: Date | null;
  national_agenda_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

export async function nationalChamberId(db: Db = pool): Promise<string | null> {
  return (await one<{ id: string }>(`SELECT id FROM chambers WHERE kind = 'national'`, [], db))?.id ?? null;
}

/** The chamber where a case is handled now: its own chamber provincially, Iran Chamber nationally. */
export async function levelChamberId(c: Pick<CouncilCase, 'level' | 'origin_chamber_id'>, db: Db = pool): Promise<string | null> {
  return c.level === 'national' ? nationalChamberId(db) : c.origin_chamber_id;
}

/** The council and expert group bodies of a chamber (active). */
export async function councilBodies(chamberId: string, db: Db = pool) {
  const rows = await query<{ id: string; body_type: 'council' | 'expert_group'; council_secretary_id: string | null; name: string }>(
    `SELECT id, body_type, council_secretary_id, name FROM commissions WHERE chamber_id = $1 AND body_type <> 'commission' AND status = 'active'`,
    [chamberId],
    db,
  );
  return { council: rows.find((r) => r.body_type === 'council') ?? null, expert: rows.find((r) => r.body_type === 'expert_group') ?? null };
}

export interface CouncilContext {
  secretariat: string[]; // chambers where the user is the council's secretariat
  member: string[]; // chambers where the user belongs to the council or its expert group
  president: string[]; // chambers whose council secretary (دبیر شورا) the user is
  originAll: string[]; // commissions the user belongs to
  originSecretariat: string[]; // commissions where the user is the secretary
  nationalChamber: string | null;
}

export async function councilContext(u: AuthUser, db: Db = pool): Promise<CouncilContext> {
  const ms = await query<{ commission_id: string; chamber_id: string; position: string; body_type: string }>(
    `SELECT m.commission_id, c.chamber_id, m.position, c.body_type FROM commission_memberships m JOIN commissions c ON c.id = m.commission_id
      WHERE m.user_id = $1 AND m.status = 'active' AND c.status = 'active'`,
    [u.id],
    db,
  );
  const pres = await query<{ chamber_id: string }>(
    `SELECT chamber_id FROM commissions WHERE council_secretary_id = $1 AND body_type = 'council' AND status = 'active'`,
    [u.id],
    db,
  );
  const body = ms.filter((m) => m.body_type !== 'commission');
  const commissions = ms.filter((m) => m.body_type === 'commission');
  return {
    secretariat: [...new Set(body.filter((m) => m.position === 'secretary').map((m) => m.chamber_id))],
    member: [...new Set([...body.map((m) => m.chamber_id), ...pres.map((p) => p.chamber_id)])],
    president: pres.map((p) => p.chamber_id),
    originAll: commissions.map((m) => m.commission_id),
    originSecretariat: commissions.filter((m) => m.position === 'secretary').map((m) => m.commission_id),
    nationalChamber: await nationalChamberId(db),
  };
}

/** SQL condition (on alias `c`) for the cases the user may see; its parameters start at `$${from}`. */
export function caseVisibility(u: AuthUser, ctx: CouncilContext, from: number): { where: string; params: unknown[] } {
  const p = (i: number) => `$${from + i}`;
  const full = [...ctx.secretariat, ...ctx.president];
  const where = `(
    c.origin_chamber_id = ANY(${p(0)}::uuid[])
    OR (c.national_reached_at IS NOT NULL AND ${p(5)}::uuid = ANY(${p(0)}::uuid[]))
    OR (c.origin_chamber_id = ANY(${p(1)}::uuid[]) AND (NOT c.confidential OR c.provincial_agenda_at IS NOT NULL))
    OR (c.national_reached_at IS NOT NULL AND ${p(5)}::uuid = ANY(${p(1)}::uuid[]) AND (NOT c.confidential OR c.national_agenda_at IS NOT NULL))
    OR (c.origin_commission_id = ANY(${p(2)}::uuid[]) AND NOT c.confidential)
    OR c.origin_commission_id = ANY(${p(3)}::uuid[])
    OR c.origin_chamber_id = ANY(${p(4)}::uuid[])
    OR EXISTS (SELECT 1 FROM agenda_items ai JOIN meeting_invitees i ON i.meeting_id = ai.meeting_id
                WHERE ai.council_case_id = c.id AND i.user_id = ${p(6)})
  )`;
  return {
    where,
    params: [full, ctx.member, ctx.originAll, ctx.originSecretariat, u.adminChambers, ctx.nationalChamber, u.id],
  };
}

export interface CaseAccess {
  case: CouncilCase;
  levelChamber: string | null;
  actors: CaseActor[];
  ctx: CouncilContext;
}

/** Loads a case the user may see, with the roles they act in on it now. */
export async function caseAccess(u: AuthUser, id: string, db: Db = pool, forUpdate = false): Promise<CaseAccess> {
  const ctx = await councilContext(u, db);
  const v = caseVisibility(u, ctx, 2);
  const c = await one<CouncilCase>(`SELECT c.* FROM council_cases c WHERE c.id = $1 AND ${v.where}${forUpdate ? ' FOR UPDATE OF c' : ''}`, [id, ...v.params], db);
  if (!c) throw notFound('پرونده یافت نشد');
  const levelChamber = await levelChamberId(c, db);
  const actors: CaseActor[] = [];
  if (levelChamber && ctx.secretariat.includes(levelChamber)) actors.push('secretariat');
  if (levelChamber && ctx.president.includes(levelChamber)) actors.push('president');
  const originManager =
    !!c.origin_commission_id && (await commissionAccess(u, c.origin_commission_id, db).then((a) => a.can('resolution.manage')).catch(() => false));
  if (originManager || (c.level === 'provincial' && ctx.secretariat.includes(c.origin_chamber_id))) actors.push('origin');
  return { case: c, levelChamber, actors, ctx };
}

/** Next tracking code: year (Jalali) and a running number, e.g. 1405-0012. */
export async function nextCaseCode(db: Db): Promise<string> {
  const n = Number((await one<{ n: string }>(`SELECT nextval('council_case_seq') AS n`, [], db))!.n);
  const d = new Date();
  const [jy] = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${jy}-${String(n).padStart(4, '0')}`;
}

/** The secretariat (and optionally the council secretary) of a chamber's council. */
export async function councilPeople(chamberId: string | null, opts: { president?: boolean } = {}, db: Db = pool): Promise<string[]> {
  if (!chamberId) return [];
  const rows = await query<{ user_id: string }>(
    `SELECT m.user_id FROM commission_memberships m JOIN commissions c ON c.id = m.commission_id
      WHERE c.chamber_id = $1 AND c.body_type <> 'commission' AND c.status = 'active' AND m.status = 'active' AND m.position = 'secretary'
     UNION
     SELECT council_secretary_id FROM commissions WHERE $2::boolean AND chamber_id = $1 AND body_type = 'council' AND status = 'active' AND council_secretary_id IS NOT NULL`,
    [chamberId, !!opts.president],
    db,
  );
  return rows.map((r) => r.user_id);
}

/** The originating commission's secretaries. */
export async function originPeople(commissionId: string | null, db: Db = pool): Promise<string[]> {
  if (!commissionId) return [];
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position IN ('secretary','chair')`,
    [commissionId],
    db,
  );
  return rows.map((r) => r.user_id);
}

export async function notifyCase(
  c: Pick<CouncilCase, 'id' | 'code' | 'title' | 'origin_chamber_id' | 'origin_commission_id' | 'level'>,
  event: NotificationEvent,
  title: string,
  body: string,
  userIds: string[],
): Promise<void> {
  await notify({ chamberId: c.origin_chamber_id, userIds, event, title, body, data: { councilCaseId: c.id } });
}
