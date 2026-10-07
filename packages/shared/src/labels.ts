import type {
  AgendaStatus,
  AttendanceStatus,
  InviteeRole,
  IssueStatus,
  MeetingStatus,
  MeetingType,
  MinutesStatus,
  Priority,
  ResolutionStatus,
  TermStatus,
  TaskStatus,
} from './domain.js';

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  draft: 'پیش‌نویس',
  scheduled: 'برنامه‌ریزی‌شده',
  invitation_sent: 'دعوت‌نامه ارسال شد',
  checkin_open: 'اعلام حضور باز است',
  in_progress: 'در حال برگزاری',
  agenda_processing: 'در حال بررسی دستور جلسه',
  minutes_draft: 'پیش‌نویس صورتجلسه',
  pending_approval: 'در انتظار تأیید صورتجلسه',
  approved: 'صورتجلسه تأیید شد',
  archived: 'بایگانی',
  cancelled: 'لغو شده',
};

export const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  in_person: 'حضوری',
  online: 'آنلاین',
  hybrid: 'ترکیبی',
};

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  pending: 'در انتظار اعلام حضور',
  present: 'حاضر',
  online: 'حضور آنلاین',
  proxy: 'نماینده عضو حاضر است',
  manual_present: 'حضور ثبت‌شده توسط دبیر',
  absent: 'غایب',
  excused: 'غیبت موجه',
};

export const AGENDA_STATUS_LABELS: Record<AgendaStatus, string> = {
  pending: 'در انتظار',
  active: 'در حال بررسی',
  done: 'خاتمه‌یافته',
  referred: 'ارجاع‌شده',
  removed: 'حذف‌شده',
};

export const ROLE_LABELS: Record<InviteeRole, string> = {
  chair: 'رئیس',
  vice_chair: 'نایب‌رئیس',
  secretary: 'دبیر',
  member: 'عضو',
  expert: 'کارشناس',
  observer: 'ناظر',
  guest: 'مدعو',
};

export const MINUTES_STATUS_LABELS: Record<MinutesStatus, string> = {
  draft: 'پیش‌نویس',
  pending_approval: 'در انتظار تأیید رئیس',
  returned: 'برگشت برای اصلاح',
  approved: 'تأیید و قفل شده',
};

export const RESOLUTION_STATUS_LABELS: Record<ResolutionStatus, string> = {
  open: 'باز',
  in_progress: 'در حال اجرا',
  submitted: 'ارسال برای بررسی',
  done: 'انجام شده',
  returned: 'برگشت داده شده',
  cancelled: 'لغو شده',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'کم',
  normal: 'عادی',
  high: 'زیاد',
  urgent: 'فوری',
};

export const TERM_STATUS_LABELS: Record<TermStatus, string> = {
  planned: 'برنامه‌ریزی‌شده',
  active: 'فعال',
  closed: 'خاتمه‌یافته',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'انجام نشده',
  in_progress: 'در حال انجام',
  done: 'انجام شده',
  cancelled: 'لغو شده',
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'باز',
  under_review: 'در حال کارشناسی',
  on_agenda: 'در دستور جلسه',
  resolved: 'حل‌شده',
  closed: 'بسته',
};

/** Persian title of a role: custom roles carry their own title, built-ins use ROLE_LABELS. */
export function roleLabel(key: string | null | undefined, customTitle?: string | null): string {
  if (customTitle) return customTitle;
  if (!key) return '—';
  if (key === 'chamber_admin') return 'مدیر اتاق';
  if (key === 'delegate') return 'نماینده';
  return (ROLE_LABELS as Record<string, string>)[key] ?? key;
}
