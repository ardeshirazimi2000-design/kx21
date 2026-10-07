import type { InviteeRole, Position } from './domain.js';

/**
 * Roles & permissions (section 14 of the spec), configurable per chamber.
 *
 * Access is resolved per request from:
 *  - system roles (super admin / chamber admin of the chamber),
 *  - the user's role (position) in the commission (CommissionMembership),
 *  - the user's role in a specific meeting (MeetingInvitee).
 *
 * Each role has a set of *configurable* capabilities. Defaults are below; a chamber can override
 * the set of any role and define its own custom roles (RoleMatrix). Tenancy (chamber) and
 * commission scoping is enforced by the API before these checks.
 */
export const CAPABILITIES = [
  'commission.view',
  'commission.manage',
  'commission.browse', // see all meetings, minutes, resolutions and issues of the commission
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
  'issue.manage', // issues and expert referrals
  'report.commission',
  'report.chamber',
  'audit.view',
  'chamber.manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities an admin can switch on/off per role. */
export const CONFIGURABLE_CAPABILITIES = [
  'commission.browse',
  'minutes.view',
  'report.commission',
  'attendance.self',
  'comment.create',
  'vote.cast',
  'vote.results.view',
  'attendance.view_all',
  'meeting.manage',
  'meeting.control',
  'minutes.approve',
  'resolution.manage',
  'issue.manage',
] as const satisfies readonly Capability[];
export type ConfigurableCapability = (typeof CONFIGURABLE_CAPABILITIES)[number];

/** Only meaningful for someone invited to the meeting (granted through the meeting role). */
export const INVITE_ONLY_CAPABILITIES: readonly Capability[] = ['attendance.self', 'comment.create', 'vote.cast'];

export const CAPABILITY_LABELS: Record<ConfigurableCapability, { title: string; group: string }> = {
  'commission.browse': { title: 'مشاهده همه جلسات، مصوبات و مسائل کمیسیون', group: 'مشاهده' },
  'minutes.view': { title: 'مشاهده صورتجلسه‌های تأییدشده', group: 'مشاهده' },
  'report.commission': { title: 'داشبورد و گزارش‌های کمیسیون', group: 'مشاهده' },
  'vote.results.view': { title: 'مشاهده نتیجه رأی‌گیری', group: 'مشاهده' },
  'attendance.view_all': { title: 'مشاهده لیست زنده حاضرین و جزئیات حد نصاب', group: 'مشاهده' },
  'attendance.self': { title: 'اعلام حضور (در صورت دعوت)', group: 'مشارکت در جلسه' },
  'comment.create': { title: 'ثبت نظر روی دستور جلسه (در صورت دعوت)', group: 'مشارکت در جلسه' },
  'vote.cast': { title: 'رأی دادن (در صورت دعوت و داشتن حق رأی)', group: 'مشارکت در جلسه' },
  'meeting.manage': { title: 'ایجاد و ویرایش جلسه، دعوت، دستور جلسه، مستندات، اصلاح حضور، تنظیم صورتجلسه', group: 'اجرای کمیسیون' },
  'meeting.control': { title: 'شروع و پایان جلسه، فعال‌سازی آیتم، شروع و پایان رأی‌گیری', group: 'اجرای کمیسیون' },
  'minutes.approve': { title: 'تأیید یا برگشت صورتجلسه', group: 'اجرای کمیسیون' },
  'resolution.manage': { title: 'ثبت مصوبه و بررسی گزارش اجرا', group: 'اجرای کمیسیون' },
  'issue.manage': { title: 'مدیریت مسائل و ارجاع کارشناسی', group: 'اجرای کمیسیون' },
};

/** Built-in roles. `chamber_admin` is a chamber-level role; the others are commission/meeting roles. */
export const BUILTIN_ROLES = ['chamber_admin', 'chair', 'vice_chair', 'secretary', 'member', 'expert', 'observer', 'guest'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/** Capabilities a chamber admin always has (cannot be removed, to avoid locking the chamber out). */
export const LOCKED_ADMIN_CAPABILITIES: readonly Capability[] = ['commission.view', 'commission.manage', 'report.chamber', 'audit.view'];

const VIEW: ConfigurableCapability[] = ['commission.browse', 'minutes.view', 'report.commission'];
const PARTICIPATE: ConfigurableCapability[] = ['attendance.self', 'comment.create', 'vote.cast', 'vote.results.view'];
const EXECUTE: ConfigurableCapability[] = ['attendance.view_all', 'meeting.manage', 'meeting.control', 'resolution.manage', 'issue.manage'];

export const DEFAULT_ROLE_CAPABILITIES: Record<BuiltinRole, ConfigurableCapability[]> = {
  // Structure + oversight only: commission work belongs to its secretary.
  chamber_admin: ['commission.browse', 'minutes.view', 'report.commission', 'vote.results.view', 'attendance.view_all'],
  chair: [...VIEW, ...PARTICIPATE, ...EXECUTE, 'minutes.approve'],
  vice_chair: [...VIEW, ...PARTICIPATE, ...EXECUTE, 'minutes.approve'],
  secretary: [...VIEW, ...PARTICIPATE, ...EXECUTE],
  member: [...VIEW, ...PARTICIPATE],
  expert: ['minutes.view', 'attendance.self', 'comment.create', 'vote.results.view'],
  observer: [...VIEW, 'attendance.self', 'vote.results.view'],
  guest: ['minutes.view', 'attendance.self', 'vote.results.view'],
};

/** role key → capabilities. Missing roles fall back to the defaults (custom roles to nothing). */
export type RoleMatrix = Partial<Record<string, readonly Capability[]>>;

export function roleCapabilities(role: string, matrix?: RoleMatrix | null): readonly Capability[] {
  return matrix?.[role] ?? (DEFAULT_ROLE_CAPABILITIES as Record<string, Capability[]>)[role] ?? [];
}

export interface AccessContext {
  isSuperAdmin: boolean;
  isChamberAdmin: boolean;
  /** Role (position) in the commission, if the user has an active membership. */
  position?: Position | string | null;
  /** Role in the meeting, if invited. */
  inviteeRole?: InviteeRole | string | null;
  /** Voting right in the meeting (from invitation snapshot). */
  hasVote?: boolean;
  /** Commission setting: who sees vote results. */
  resultVisibility?: 'invitees' | 'officers';
  /** The chamber's role configuration (overrides and custom roles). */
  roleMatrix?: RoleMatrix | null;
}

const OFFICERS: readonly string[] = ['chair', 'vice_chair', 'secretary'];

export function isOfficer(role?: string | null): boolean {
  return !!role && OFFICERS.includes(role);
}

export function resolveCapabilities(ctx: AccessContext): Set<Capability> {
  const caps = new Set<Capability>();
  const matrix = ctx.roleMatrix;
  const isAdmin = ctx.isSuperAdmin || ctx.isChamberAdmin;
  const add = (list: readonly Capability[], includeInviteOnly: boolean) => {
    for (const c of list) if (includeInviteOnly || !INVITE_ONLY_CAPABILITIES.includes(c)) caps.add(c);
  };

  if (isAdmin) {
    for (const c of LOCKED_ADMIN_CAPABILITIES) caps.add(c);
    if (ctx.isSuperAdmin) caps.add('chamber.manage');
    add(roleCapabilities('chamber_admin', matrix), false);
  }

  const pos = ctx.position ?? null;
  const inv = ctx.inviteeRole ?? null;

  // Commission role: applies to every meeting of the commission (invite-only rights excluded).
  if (pos) {
    caps.add('commission.view');
    add(roleCapabilities(pos, matrix), false);
  }

  // Meeting role: applies to that meeting.
  if (inv) {
    caps.add('meeting.view');
    add(roleCapabilities(inv, matrix), true);
    if (!ctx.hasVote) caps.delete('vote.cast');
  } else {
    caps.delete('vote.cast');
  }

  if (caps.has('commission.browse')) caps.add('meeting.view');

  // "Results only for officers": results stay with whoever runs the meeting (and admins).
  if ((ctx.resultVisibility ?? 'invitees') === 'officers' && !caps.has('meeting.control') && !isAdmin) {
    caps.delete('vote.results.view');
  }
  return caps;
}

export function can(ctx: AccessContext, cap: Capability): boolean {
  return resolveCapabilities(ctx).has(cap);
}

/** Default voting right for a built-in position when inviting commission members. */
export function positionHasVote(pos: string): boolean {
  return pos === 'chair' || pos === 'vice_chair' || pos === 'member';
}
