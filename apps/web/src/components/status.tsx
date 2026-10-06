import {
  AGENDA_STATUS_LABELS,
  ATTENDANCE_STATUS_LABELS,
  MEETING_STATUS_LABELS,
  MINUTES_STATUS_LABELS,
  PRIORITY_LABELS,
  RESOLUTION_STATUS_LABELS,
  type AgendaStatus,
  type AttendanceStatus,
  type MeetingStatus,
  type MinutesStatus,
  type Priority,
  type ResolutionStatus,
} from '@kx/shared';
import { Badge, type Tone } from './ui';

const MEETING_TONE: Record<MeetingStatus, Tone> = {
  draft: 'neutral',
  scheduled: 'info',
  invitation_sent: 'info',
  checkin_open: 'accent',
  in_progress: 'success',
  agenda_processing: 'success',
  minutes_draft: 'warning',
  pending_approval: 'warning',
  approved: 'neutral',
  archived: 'neutral',
  cancelled: 'danger',
};

export const MeetingStatusBadge = ({ status }: { status: MeetingStatus }) => <Badge tone={MEETING_TONE[status]}>{MEETING_STATUS_LABELS[status]}</Badge>;

const ATT_TONE: Record<AttendanceStatus, Tone> = {
  pending: 'neutral',
  present: 'success',
  online: 'info',
  proxy: 'accent',
  manual_present: 'success',
  absent: 'danger',
  excused: 'warning',
};
export const AttendanceBadge = ({ status }: { status: AttendanceStatus }) => <Badge tone={ATT_TONE[status]}>{ATTENDANCE_STATUS_LABELS[status]}</Badge>;

const AGENDA_TONE: Record<AgendaStatus, Tone> = { pending: 'neutral', active: 'success', done: 'info', referred: 'accent', removed: 'danger' };
export const AgendaBadge = ({ status }: { status: AgendaStatus }) => <Badge tone={AGENDA_TONE[status]}>{AGENDA_STATUS_LABELS[status]}</Badge>;

const RES_TONE: Record<ResolutionStatus, Tone> = { open: 'info', in_progress: 'accent', submitted: 'warning', done: 'success', returned: 'danger', cancelled: 'neutral' };
export const ResolutionBadge = ({ status, overdue }: { status: ResolutionStatus; overdue?: boolean }) => (
  <span className="row gap-sm">
    <Badge tone={RES_TONE[status]}>{RESOLUTION_STATUS_LABELS[status]}</Badge>
    {overdue && <Badge tone="danger">معوق</Badge>}
  </span>
);

const MIN_TONE: Record<MinutesStatus, Tone> = { draft: 'neutral', pending_approval: 'warning', returned: 'danger', approved: 'success' };
export const MinutesBadge = ({ status }: { status: MinutesStatus }) => <Badge tone={MIN_TONE[status]}>{MINUTES_STATUS_LABELS[status]}</Badge>;

const PRI_TONE: Record<Priority, Tone> = { low: 'neutral', normal: 'info', high: 'warning', urgent: 'danger' };
export const PriorityBadge = ({ priority }: { priority: Priority }) => <Badge tone={PRI_TONE[priority]}>{PRIORITY_LABELS[priority]}</Badge>;
