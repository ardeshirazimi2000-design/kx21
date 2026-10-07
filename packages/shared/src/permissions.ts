import type { InviteeRole, Position } from './domain.js';

/**
 * Permission matrix (section 14 of the spec). Access is resolved per request from:
 *  - system roles (super admin / chamber admin of the meeting's chamber),
 *  - the user's position in the commission (CommissionMembership),
 *  - the user's role in a specific meeting (MeetingInvitee).
 * Tenancy (chamber) and commission scoping is enforced by the API before these checks.
 */
export const CAPABILITIES = [
  'commission.view',
  'commission.manage',
  'meeting.view',
  'meeting.manage', // create/edit meeting, agenda, invitees, open check-in, fix attendance, edit minutes
  'meeting.control', // start/end meeting, activate agenda items, open/close votes
  'attendance.view_all', // live attendance list + quorum details
  'attendance.self', // self check-in
  'comment.create',
  'vote.cast',
  'vote.results.view',
  'minutes.view',
  'minutes.approve',
  'resolution.manage', // create resolutions, review progress
  'issue.manage',
  'report.commission',
  'report.chamber',
  'audit.view',
  'chamber.manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface AccessContext {
  isSuperAdmin: boolean;
  isChamberAdmin: boolean;
  /** Position in the commission, if the user has an active membership. */
  position?: Position | null;
  /** Role in the meeting, if invited. */
  inviteeRole?: InviteeRole | null;
  /** Voting right in the meeting (from invitation snapshot). */
  hasVote?: boolean;
  /** Commission setting: who sees vote results. */
  resultVisibility?: 'invitees' | 'officers';
}

const OFFICERS: readonly (Position | InviteeRole)[] = ['chair', 'vice_chair', 'secretary'];

export function isOfficer(role?: Position | InviteeRole | null): boolean {
  return !!role && OFFICERS.includes(role);
}

export function resolveCapabilities(ctx: AccessContext): Set<Capability> {
  const caps = new Set<Capability>();
  if (ctx.isSuperAdmin || ctx.isChamberAdmin) {
    for (const c of CAPABILITIES) caps.add(c);
    // Admins define the structure (terms, commissions, members, positions) and supervise.
    // Executive work of a commission — meetings, attendance, live control, minutes, resolutions,
    // expert referrals — belongs to that commission's secretary (and chair), not to the admin.
    for (const c of ['vote.cast', 'attendance.self', 'minutes.approve', 'meeting.control', 'meeting.manage', 'resolution.manage', 'issue.manage'] as const) {
      caps.delete(c);
    }
    if (!ctx.isSuperAdmin) caps.delete('chamber.manage');
  }

  const pos = ctx.position ?? null;
  const inv = ctx.inviteeRole ?? null;

  if (pos) {
    caps.add('commission.view');
    if (pos !== 'expert') caps.add('report.commission');
  }

  // Members/observers see all meetings of their commission; experts only those they're invited to.
  if ((pos && pos !== 'expert') || inv) {
    caps.add('meeting.view');
    caps.add('minutes.view');
  }

  if (isOfficer(pos) || isOfficer(inv)) {
    caps.add('meeting.manage');
    caps.add('meeting.control');
    caps.add('attendance.view_all');
    caps.add('resolution.manage');
    caps.add('issue.manage');
    caps.add('vote.results.view');
  }
  if (pos === 'chair' || pos === 'vice_chair' || inv === 'chair' || inv === 'vice_chair') {
    caps.add('minutes.approve');
  }

  if (inv) {
    caps.add('attendance.self');
    if (inv !== 'observer' && inv !== 'guest') caps.add('comment.create');
    if (ctx.hasVote) caps.add('vote.cast');
    if ((ctx.resultVisibility ?? 'invitees') === 'invitees') caps.add('vote.results.view');
  }

  return caps;
}

export function can(ctx: AccessContext, cap: Capability): boolean {
  return resolveCapabilities(ctx).has(cap);
}

/** Default voting right for a position when inviting commission members. */
export function positionHasVote(pos: Position): boolean {
  return pos === 'chair' || pos === 'vice_chair' || pos === 'member';
}
