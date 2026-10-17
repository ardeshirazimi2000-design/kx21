import { Badge, type Tone } from './ui';

export const KIND: Record<string, string> = { incoming: 'وارده', outgoing: 'صادره', internal: 'داخلی' };
export const KIND_TONE: Record<string, Tone> = { incoming: 'info', outgoing: 'accent', internal: 'neutral' };

export const STATUS: Record<string, [string, Tone]> = {
  draft: ['پیش‌نویس', 'neutral'],
  registered: ['ثبت‌شده', 'info'],
  in_progress: ['در جریان', 'warning'],
  approved: ['تأییدشده', 'success'],
  signed: ['امضاشده', 'success'],
  sent: ['ارسال‌شده', 'accent'],
  archived: ['بایگانی', 'neutral'],
  cancelled: ['ابطال', 'danger'],
};

export const PRIORITY: Record<string, [string, Tone]> = {
  low: ['کم', 'neutral'],
  normal: ['عادی', 'neutral'],
  high: ['فوری', 'warning'],
  urgent: ['آنی', 'danger'],
};

export const CONFIDENTIALITY = ['عادی', 'محرمانه', 'سری'];

export const SOURCE: Record<string, string> = { manual: 'ثبت دستی', email: 'ایمیل', scan: 'اسکن', api: 'API', meeting: 'سامانه جلسات' };

export const ACTION: Record<string, string> = {
  refer: 'جهت اقدام',
  review: 'جهت بررسی',
  approve: 'جهت تأیید',
  sign: 'جهت امضا',
  archive: 'جهت بایگانی',
  info: 'جهت اطلاع',
  follow_up: 'جهت پیگیری',
};

export const ROUTE_STATUS: Record<string, [string, Tone]> = {
  pending: ['در انتظار', 'warning'],
  seen: ['دیده‌شده', 'info'],
  done: ['انجام‌شده', 'success'],
  returned: ['برگشتی', 'danger'],
  cancelled: ['لغو', 'neutral'],
};

export const STEP_TYPE: Record<string, string> = { review: 'بررسی', approve: 'تأیید', sign: 'امضا', archive: 'بایگانی', notify: 'اطلاع' };
export const STEP_STATUS: Record<string, [string, Tone]> = {
  pending: ['در صف', 'neutral'],
  active: ['جاری', 'warning'],
  approved: ['تأیید', 'success'],
  rejected: ['رد', 'danger'],
  skipped: ['رد شد (شرط)', 'neutral'],
  cancelled: ['لغو', 'neutral'],
};
export const WF_STATUS: Record<string, [string, Tone]> = {
  running: ['در جریان', 'warning'],
  completed: ['پایان‌یافته', 'success'],
  rejected: ['ردشده', 'danger'],
  cancelled: ['لغوشده', 'neutral'],
};

export const ASSIGNEE_KIND: Record<string, string> = {
  user: 'کاربر مشخص',
  position: 'سمت سازمانی',
  role: 'نقش',
  unit_manager: 'مدیر واحد مشخص',
  owner_unit_manager: 'مدیر واحد صاحب نامه',
  initiator_manager: 'مدیر شروع‌کننده',
  context_user: 'کاربر از متن گردش (مثلاً مسئول مصوبه)',
};

export const RESOLUTION_STATUS: Record<string, [string, Tone]> = {
  open: ['باز', 'info'],
  in_progress: ['در حال اجرا', 'warning'],
  submitted: ['ارسال برای تأیید دبیر', 'accent'],
  done: ['انجام‌شده', 'success'],
  returned: ['برگشت داده شده', 'danger'],
  cancelled: ['لغو', 'neutral'],
};

export const MEETING_STATUS: Record<string, string> = {
  draft: 'پیش‌نویس',
  scheduled: 'زمان‌بندی‌شده',
  invited: 'دعوت ارسال شد',
  in_progress: 'در حال برگزاری',
  held: 'برگزار شد',
  minutes_pending: 'در انتظار صورتجلسه',
  approved: 'صورتجلسه تأیید شد',
  cancelled: 'لغو',
  postponed: 'به تعویق افتاد',
};

export const REFERRAL_STATUS: Record<string, string> = {
  open: 'ثبت‌شده',
  under_review: 'در حال بررسی کارشناسی',
  on_agenda: 'در دستور جلسه',
  resolved: 'منجر به مصوبه',
  closed: 'مختومه',
};

export function Pill({ map, value }: { map: Record<string, [string, Tone]>; value: string | null | undefined }) {
  if (!value) return null;
  const [label, tone] = map[value] ?? [value, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}

export function KindBadge({ kind }: { kind: string }) {
  return <Badge tone={KIND_TONE[kind]}>{KIND[kind] ?? kind}</Badge>;
}

export function ConfBadge({ level }: { level: number }) {
  if (!level) return null;
  return <Badge tone="danger">{CONFIDENTIALITY[level]}</Badge>;
}
