import {
  mergeCommissionSettings,
  resolveCapabilities,
  type AccessContext,
  type Capability,
  type CommissionSettings,
  type InviteeRole,
  type MeetingStatus,
  type Position,
} from '@kx/shared';
import type { AuthUser } from '../auth/middleware.js';
import { one, query, pool, type Db } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';
import { loadRoleMatrix } from './roles.js';

export function isChamberAdmin(user: AuthUser, chamberId: string): boolean {
  return user.isSuperAdmin || user.adminChambers.includes(chamberId);
}

export function requireChamberAdmin(user: AuthUser, chamberId: string) {
  if (!isChamberAdmin(user, chamberId)) throw forbidden();
}

export function requireSuperAdmin(user: AuthUser) {
  if (!user.isSuperAdmin) throw forbidden();
}

/** Chambers the user may see at all (null = all chambers). */
export async function visibleChamberIds(user: AuthUser, db: Db = pool): Promise<string[] | null> {
  if (user.isSuperAdmin) return null;
  const rows = await query<{ chamber_id: string }>(
    `SELECT DISTINCT chamber_id FROM commission_memberships WHERE user_id = $1 AND status = 'active'
     UNION SELECT DISTINCT m.chamber_id FROM meeting_invitees i JOIN meetings m ON m.id = i.meeting_id WHERE i.user_id = $1`,
    [user.id],
    db,
  );
  const set = new Set([...user.adminChambers, ...rows.map((r) => r.chamber_id)]);
  if (user.chamberId) set.add(user.chamberId);
  return [...set];
}

export interface CommissionRow {
  id: string;
  chamber_id: string;
  term_id: string;
  name: string;
  code: string;
  status: string;
  settings: unknown;
}

export interface CommissionAccess {
  commission: CommissionRow;
  settings: CommissionSettings;
  position: Position | string | null;
  caps: Set<Capability>;
  can: (c: Capability) => boolean;
  require: (c: Capability) => void;
}

export async function activePosition(userId: string, commissionId: string, db: Db = pool): Promise<string | null> {
  const m = await one<{ position: string }>(
    `SELECT position FROM commission_memberships WHERE user_id = $1 AND commission_id = $2 AND status = 'active'
       AND (end_date IS NULL OR end_date >= current_date)`,
    [userId, commissionId],
    db,
  );
  return m?.position ?? null;
}

export async function commissionAccess(user: AuthUser, commissionId: string, db: Db = pool): Promise<CommissionAccess> {
  const commission = await one<CommissionRow>('SELECT * FROM commissions WHERE id = $1', [commissionId], db);
  if (!commission) throw notFound('کمیسیون یافت نشد');
  const position = await activePosition(user.id, commissionId, db);
  const settings = mergeCommissionSettings(commission.settings);
  const ctx: AccessContext = {
    isSuperAdmin: user.isSuperAdmin,
    isChamberAdmin: user.adminChambers.includes(commission.chamber_id),
    position,
    resultVisibility: settings.resultVisibility,
    roleMatrix: await loadRoleMatrix(commission.chamber_id, db),
  };
  const caps = resolveCapabilities(ctx);
  if (!caps.has('commission.view')) throw notFound('کمیسیون یافت نشد');
  return {
    commission,
    settings,
    position,
    caps,
    can: (c) => caps.has(c),
    require: (c) => {
      if (!caps.has(c)) throw forbidden();
    },
  };
}

export interface MeetingRow {
  id: string;
  chamber_id: string;
  commission_id: string;
  number: number;
  title: string;
  scheduled_at: Date;
  duration_minutes: number;
  location: string | null;
  online_link: string | null;
  type: string;
  status: MeetingStatus;
  cancel_reason: string | null;
  checkin_closed_at: Date | null;
  started_at: Date | null;
  started_by: string | null;
  ended_at: Date | null;
  created_by: string | null;
}

export interface MeetingAccess {
  meeting: MeetingRow;
  commission: CommissionRow;
  settings: CommissionSettings;
  position: Position | string | null;
  inviteeRole: InviteeRole | string | null;
  hasVote: boolean;
  caps: Set<Capability>;
  can: (c: Capability) => boolean;
  require: (c: Capability) => void;
}

/**
 * Loads a meeting with the caller's capabilities on it. Meetings the user may not view
 * are reported as 404 so their existence does not leak across commissions/chambers.
 * Pass `forUpdate` inside a transaction to lock the meeting row.
 */
export async function meetingAccess(
  user: AuthUser,
  meetingId: string,
  db: Db = pool,
  opts: { forUpdate?: boolean } = {},
): Promise<MeetingAccess> {
  const meeting = await one<MeetingRow>(
    `SELECT * FROM meetings WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [meetingId],
    db,
  );
  if (!meeting) throw notFound('جلسه یافت نشد');
  const commission = (await one<CommissionRow>('SELECT * FROM commissions WHERE id = $1', [meeting.commission_id], db))!;
  const position = await activePosition(user.id, meeting.commission_id, db);
  const inv = await one<{ role: string; has_vote: boolean }>(
    'SELECT role, has_vote FROM meeting_invitees WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, user.id],
    db,
  );
  const settings = mergeCommissionSettings(commission.settings);
  const caps = resolveCapabilities({
    isSuperAdmin: user.isSuperAdmin,
    isChamberAdmin: user.adminChambers.includes(meeting.chamber_id),
    position,
    inviteeRole: inv?.role ?? null,
    hasVote: inv?.has_vote ?? false,
    resultVisibility: settings.resultVisibility,
    roleMatrix: await loadRoleMatrix(meeting.chamber_id, db),
  });
  if (!caps.has('meeting.view')) throw notFound('جلسه یافت نشد');
  return {
    meeting,
    commission,
    settings,
    position,
    inviteeRole: inv?.role ?? null,
    hasVote: inv?.has_vote ?? false,
    caps,
    can: (c) => caps.has(c),
    require: (c) => {
      if (!caps.has(c)) throw forbidden();
    },
  };
}

export async function meetingIdOfAgendaItem(itemId: string, db: Db = pool): Promise<string> {
  const r = await one<{ meeting_id: string }>('SELECT meeting_id FROM agenda_items WHERE id = $1', [itemId], db);
  if (!r) throw notFound('دستور جلسه یافت نشد');
  return r.meeting_id;
}
