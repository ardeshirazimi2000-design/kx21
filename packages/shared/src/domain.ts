/**
 * Core domain enums and DTO shapes shared by the API, web and mobile apps.
 * Hierarchy: Chamber → Term → Commission → Membership → Meeting → AgendaItem
 *            → Attendance / Vote → Minutes → Resolution → Task → Report
 */

export const SYSTEM_ROLES = ['super_admin', 'chamber_admin'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Position of a person inside a commission (CommissionMembership.position). */
export const POSITIONS = ['chair', 'vice_chair', 'secretary', 'member', 'expert', 'observer'] as const;
export type Position = (typeof POSITIONS)[number];

/** Role of a person inside a single meeting (MeetingInvitee.role). */
export const INVITEE_ROLES = ['chair', 'vice_chair', 'secretary', 'member', 'expert', 'observer', 'guest'] as const;
export type InviteeRole = (typeof INVITEE_ROLES)[number];

export const TERM_STATUSES = ['planned', 'active', 'closed'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

export const COMMISSION_STATUSES = ['active', 'inactive', 'dissolved'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const MEETING_TYPES = ['in_person', 'online', 'hybrid'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const MEETING_STATUSES = [
  'draft',
  'scheduled',
  'invitation_sent',
  'checkin_open',
  'in_progress',
  'agenda_processing',
  'minutes_draft',
  'pending_approval',
  'approved',
  'archived',
  'cancelled',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const AGENDA_STATUSES = ['pending', 'active', 'done', 'referred', 'removed'] as const;
export type AgendaStatus = (typeof AGENDA_STATUSES)[number];

export const ATTENDANCE_STATUSES = [
  'pending', // در انتظار اعلام حضور
  'present', // حاضر (اعلام حضور توسط خود عضو)
  'online', // حضور آنلاین
  'proxy', // نماینده عضو حاضر است
  'manual_present', // حضور ثبت‌شده توسط دبیر
  'absent', // غایب
  'excused', // غیبت موجه
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_METHODS = ['app', 'web', 'manual', 'online'] as const;
export type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number];

export const VOTE_SESSION_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type VoteSessionStatus = (typeof VOTE_SESSION_STATUSES)[number];

export const MINUTES_STATUSES = ['draft', 'pending_approval', 'returned', 'approved'] as const;
export type MinutesStatus = (typeof MINUTES_STATUSES)[number];

export const RESOLUTION_STATUSES = ['open', 'in_progress', 'submitted', 'done', 'returned', 'cancelled'] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ISSUE_STATUSES = ['open', 'under_review', 'on_agenda', 'resolved', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const REFERRAL_STATUSES = ['pending', 'answered', 'cancelled'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'sms', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENTS = [
  'meeting.invited',
  'meeting.changed',
  'meeting.cancelled',
  'meeting.checkin_opened',
  'meeting.checkin_reminder',
  'meeting.quorum_not_reached',
  'vote.opened',
  'vote.result',
  'minutes.pending_approval',
  'minutes.returned',
  'minutes.approved',
  'resolution.created',
  'resolution.due_soon',
  'resolution.overdue',
  'resolution.reviewed',
  'referral.created',
  'referral.answered',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Quorum rule, configured per commission. */
export interface QuorumRule {
  /** majority = more than half; percent = ceil(n*value/100); fixed = value people; two_thirds = ceil(2n/3) */
  type: 'majority' | 'percent' | 'fixed' | 'two_thirds';
  value?: number;
  /** Whether a proxy (نماینده) counts toward quorum. */
  countProxy: boolean;
  /** Whether online attendance counts toward quorum. */
  countOnline: boolean;
}

export type PassRule =
  /** yes > half of present voting members */
  | 'majority_of_present'
  /** yes > half of the votes cast (abstain counted as cast) */
  | 'majority_of_cast'
  /** yes > no */
  | 'simple_majority'
  /** yes ≥ two thirds of present voting members */
  | 'two_thirds_of_present';

export interface CommissionSettings {
  quorum: QuorumRule;
  /** Block opening votes when quorum is not reached. */
  requireQuorumForVoting: boolean;
  /** Block starting the meeting when quorum is not reached. */
  requireQuorumToStart: boolean;
  /** Allow a proxy to attend instead of the member. */
  allowProxy: boolean;
  /** A delegate (نماینده معرفی‌شده) may vote on behalf of an invitee who has a voting right. */
  proxyCanVote: boolean;
  /** Delegates must be introduced with an official letter (معرفی‌نامه). */
  requireDelegateLetter: boolean;
  /** Default secret ballot for new votes. */
  secretVoteDefault: boolean;
  /** Who can see vote results: everybody invited, or only officers (chair/secretary). */
  resultVisibility: 'invitees' | 'officers';
  passRule: PassRule;
  /** Allow more than one active agenda item at the same time. */
  allowParallelAgenda: boolean;
  /** Members may comment on the active agenda item. */
  allowComments: boolean;
  /** Days before due date to send "due soon" reminders for resolutions. */
  dueSoonDays: number;
}

export const DEFAULT_COMMISSION_SETTINGS: CommissionSettings = {
  quorum: { type: 'majority', countProxy: true, countOnline: true },
  requireQuorumForVoting: true,
  requireQuorumToStart: false,
  allowProxy: true,
  proxyCanVote: true,
  requireDelegateLetter: false,
  secretVoteDefault: false,
  resultVisibility: 'invitees',
  passRule: 'majority_of_present',
  allowParallelAgenda: false,
  allowComments: true,
  dueSoonDays: 3,
};

export function mergeCommissionSettings(partial: unknown): CommissionSettings {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Partial<CommissionSettings>;
  return {
    ...DEFAULT_COMMISSION_SETTINGS,
    ...p,
    quorum: { ...DEFAULT_COMMISSION_SETTINGS.quorum, ...(p.quorum ?? {}) },
  };
}

export const DEFAULT_VOTE_OPTIONS = ['yes', 'no', 'abstain'] as const;

/** Real-time events emitted on the `meeting:{id}` socket room. */
export const SOCKET_EVENTS = {
  meetingUpdated: 'meeting.updated',
  attendanceUpdated: 'attendance.updated',
  quorumUpdated: 'quorum.updated',
  agendaUpdated: 'agenda.updated',
  commentCreated: 'comment.created',
  voteOpened: 'vote.opened',
  voteProgress: 'vote.progress',
  voteClosed: 'vote.closed',
  notification: 'notification',
} as const;
