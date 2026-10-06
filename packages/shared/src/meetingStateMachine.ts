import type { MeetingStatus } from './domain.js';

/**
 * Meeting lifecycle (section 8 of the spec):
 * Draft → Scheduled → Invitation Sent → Check-in Open → In Progress → Agenda Processing
 *       → Minutes Draft → Pending Approval → Approved → Archived
 * Cancelled is a separate terminal state that requires a reason.
 */
export type MeetingAction =
  | 'schedule'
  | 'send_invitations'
  | 'open_checkin'
  | 'start'
  | 'begin_agenda'
  | 'end'
  | 'submit_minutes'
  | 'return_minutes'
  | 'approve_minutes'
  | 'archive'
  | 'cancel';

interface Transition {
  from: readonly MeetingStatus[];
  to: MeetingStatus;
}

export const MEETING_TRANSITIONS: Record<MeetingAction, Transition> = {
  schedule: { from: ['draft'], to: 'scheduled' },
  send_invitations: { from: ['scheduled', 'invitation_sent'], to: 'invitation_sent' },
  open_checkin: { from: ['scheduled', 'invitation_sent'], to: 'checkin_open' },
  // "Only a scheduled meeting can go In Progress": the scheduled family is
  // scheduled / invitation_sent / checkin_open.
  start: { from: ['scheduled', 'invitation_sent', 'checkin_open'], to: 'in_progress' },
  begin_agenda: { from: ['in_progress', 'agenda_processing'], to: 'agenda_processing' },
  end: { from: ['in_progress', 'agenda_processing'], to: 'minutes_draft' },
  submit_minutes: { from: ['minutes_draft'], to: 'pending_approval' },
  return_minutes: { from: ['pending_approval'], to: 'minutes_draft' },
  approve_minutes: { from: ['pending_approval'], to: 'approved' },
  archive: { from: ['approved'], to: 'archived' },
  cancel: { from: ['draft', 'scheduled', 'invitation_sent', 'checkin_open'], to: 'cancelled' },
};

export function canTransition(status: MeetingStatus, action: MeetingAction): boolean {
  return MEETING_TRANSITIONS[action].from.includes(status);
}

export function nextStatus(status: MeetingStatus, action: MeetingAction): MeetingStatus {
  if (!canTransition(status, action)) {
    throw new InvalidTransitionError(status, action);
  }
  return MEETING_TRANSITIONS[action].to;
}

export function availableActions(status: MeetingStatus): MeetingAction[] {
  return (Object.keys(MEETING_TRANSITIONS) as MeetingAction[]).filter((a) => canTransition(status, a));
}

/** Meeting is running (members can follow live agenda / vote). */
export function isLive(status: MeetingStatus): boolean {
  return status === 'in_progress' || status === 'agenda_processing';
}

/** Meeting definition (time, place, agenda, invitees) can still be edited. */
export function isEditable(status: MeetingStatus): boolean {
  return status === 'draft' || status === 'scheduled' || status === 'invitation_sent' || status === 'checkin_open';
}

/** Members can self check-in in these states, unless check-in was explicitly closed. */
export function isCheckinWindow(status: MeetingStatus): boolean {
  return status === 'checkin_open' || isLive(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly status: MeetingStatus,
    public readonly action: MeetingAction,
  ) {
    super(`Transition "${action}" is not allowed from status "${status}"`);
    this.name = 'InvalidTransitionError';
  }
}
