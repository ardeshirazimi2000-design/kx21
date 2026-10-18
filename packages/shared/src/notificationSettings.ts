import type { NotificationEvent } from './domain.js';

/**
 * Per-chamber notification settings (تنظیمات اطلاع‌رسانی): SMS panel, mail server and the text of
 * each message. Texts may contain variables like {تاریخ} that are filled in for every recipient.
 */
export interface SmsSettings {
  enabled: boolean;
  provider: 'kavenegar';
  apiKey: string;
  sender: string;
}

export interface EmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  /** true = TLS from the start (usually port 465); false = STARTTLS when offered (587/25). */
  secure: boolean;
  user: string;
  password: string;
  from: string;
  fromName: string;
}

export interface EventChannels {
  push: { enabled: boolean };
  sms: { enabled: boolean; text: string };
  email: { enabled: boolean; subject: string; text: string };
}

export interface NotificationSettings {
  /** Address of the platform, used in {لینک}, e.g. https://commission.example.ir */
  publicUrl: string;
  sms: SmsSettings;
  email: EmailSettings;
  events: Record<NotificationEvent, EventChannels>;
}

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  'meeting.invited': 'دعوت به جلسه',
  'meeting.changed': 'تغییر زمان یا مکان جلسه',
  'meeting.cancelled': 'لغو جلسه',
  'meeting.checkin_opened': 'باز شدن اعلام حضور',
  'meeting.checkin_reminder': 'یادآوری اعلام حضور',
  'meeting.quorum_not_reached': 'به حد نصاب نرسیدن جلسه',
  'vote.opened': 'شروع رأی‌گیری',
  'vote.result': 'اعلام نتیجه رأی‌گیری',
  'minutes.pending_approval': 'صورتجلسه در انتظار تأیید رئیس',
  'minutes.returned': 'برگشت صورتجلسه برای اصلاح',
  'minutes.approved': 'تأیید نهایی صورتجلسه',
  'resolution.created': 'ثبت مصوبه و تعیین مسئول اجرا',
  'resolution.due_soon': 'نزدیک شدن مهلت مصوبه',
  'resolution.overdue': 'گذشتن مهلت مصوبه',
  'resolution.reviewed': 'نتیجه بررسی گزارش اجرای مصوبه',
  'referral.created': 'ارجاع کارشناسی',
  'referral.answered': 'پاسخ ارجاع کارشناسی',
  'network.resolution_shared': 'انتشار مصوبه در شبکه کمیسیون‌ها',
  'network.endorsed': 'حمایت کمیسیون دیگر از مصوبه',
  'network.proposal_national': 'تبدیل مصوبه به پیشنهاد ملی',
  'network.proposal_updated': 'نتیجه پیگیری پیشنهاد ملی',
  'network.similar_found': 'انتشار مصوبه مشابه مسئله کمیسیون (موتور هوشمند)',
};

/** Variables that can be used in message texts; meeting/resolution ones apply when the event has one. */
export const TEMPLATE_VARIABLES: { key: string; label: string; sample: string }[] = [
  { key: 'نام', label: 'نام گیرنده', sample: 'زهرا محمدی' },
  { key: 'عنوان', label: 'عنوان اعلان', sample: 'دعوت به جلسه: بررسی موانع صادرات' },
  { key: 'متن', label: 'متن اعلان', sample: 'سه‌شنبه ۲۹ مهر ۱۴۰۵ ساعت ۱۰:۰۰' },
  { key: 'اتاق', label: 'نام اتاق', sample: 'اتاق بازرگانی یزد' },
  { key: 'کمیسیون', label: 'نام کمیسیون', sample: 'کمیسیون تجارت و صادرات' },
  { key: 'عنوان_جلسه', label: 'عنوان جلسه', sample: 'بررسی موانع صادرات محصولات کشاورزی' },
  { key: 'شماره_جلسه', label: 'شماره جلسه', sample: '۱۳' },
  { key: 'تاریخ', label: 'تاریخ جلسه', sample: 'سه‌شنبه ۲۹ مهر ۱۴۰۵' },
  { key: 'ساعت', label: 'ساعت جلسه', sample: '۱۰:۰۰' },
  { key: 'مکان', label: 'مکان جلسه', sample: 'سالن جلسات طبقه سوم' },
  { key: 'نوع_جلسه', label: 'نوع جلسه', sample: 'ترکیبی' },
  { key: 'شماره_مصوبه', label: 'شماره مصوبه', sample: 'EXP-003' },
  { key: 'متن_مصوبه', label: 'متن مصوبه', sample: 'پیشنهاد تمدید مهلت رفع تعهد ارزی ارسال شود' },
  { key: 'مهلت', label: 'مهلت مصوبه', sample: '۱۵ آبان ۱۴۰۵' },
  { key: 'لینک', label: 'لینک صفحه در سامانه', sample: 'https://commission.example.ir/meetings/…' },
];

/** Replaces {variable} with its value; unknown or empty variables become an empty string. */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text
    .replace(/\{([^{}\s]+)\}/g, (_, k: string) => vars[k] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MEETING_SMS = '{نام} گرامی\n';
const SIGN = '\n{اتاق}';

const ev = (sms: string | null, email: string | null, subject = '{عنوان}', push = true): EventChannels => ({
  push: { enabled: push },
  sms: { enabled: sms !== null, text: sms ?? '{نام} گرامی\n{عنوان}\n{متن}' + SIGN },
  email: { enabled: email !== null, subject, text: email ?? '{نام} گرامی،\n\n{عنوان}\n{متن}\n\n{لینک}' + SIGN },
});

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  publicUrl: '',
  sms: { enabled: false, provider: 'kavenegar', apiKey: '', sender: '' },
  email: { enabled: false, host: '', port: 587, secure: false, user: '', password: '', from: '', fromName: '' },
  events: {
    'meeting.invited': ev(
      '{نام} گرامی، دعوت به جلسه {کمیسیون}: «{عنوان_جلسه}»\n{تاریخ} ساعت {ساعت}، {مکان}',
      '{نام} گرامی،\n\nاز شما برای شرکت در جلسه {شماره_جلسه} {کمیسیون} دعوت می‌شود.\n\nموضوع: {عنوان_جلسه}\nزمان: {تاریخ} ساعت {ساعت}\nمکان: {مکان}\nنوع جلسه: {نوع_جلسه}\n\nمشاهده دستور جلسه و اعلام حضور: {لینک}' + SIGN,
      'دعوت به جلسه {کمیسیون} — {تاریخ}',
    ),
    'meeting.changed': ev(MEETING_SMS + 'زمان یا مکان جلسه «{عنوان_جلسه}» {کمیسیون} تغییر کرد.\nزمان جدید: {تاریخ} ساعت {ساعت}\nمکان: {مکان}' + SIGN, null),
    'meeting.cancelled': ev(MEETING_SMS + 'جلسه «{عنوان_جلسه}» {کمیسیون} که برای {تاریخ} ساعت {ساعت} برنامه‌ریزی شده بود، لغو شد.\n{متن}' + SIGN, null),
    'meeting.checkin_opened': ev(null, null),
    'meeting.checkin_reminder': ev(null, null),
    'meeting.quorum_not_reached': ev(null, null),
    'vote.opened': ev(null, null),
    'vote.result': ev(null, null, '{عنوان}', false),
    'minutes.pending_approval': ev(null, null),
    'minutes.returned': ev(null, null),
    'minutes.approved': ev(null, null),
    'resolution.created': ev(
      null,
      '{نام} گرامی،\n\nمصوبه {شماره_مصوبه} {کمیسیون} برای اجرا به شما سپرده شد:\n«{متن_مصوبه}»\nمهلت اجرا: {مهلت}\n\nمشاهده و ثبت گزارش اجرا: {لینک}' + SIGN,
      'مصوبه {شماره_مصوبه} — {کمیسیون}',
    ),
    'resolution.due_soon': ev(null, null),
    'resolution.overdue': ev(null, '{نام} گرامی،\n\nمهلت اجرای مصوبه {شماره_مصوبه} ({مهلت}) گذشته است:\n«{متن_مصوبه}»\n\nلطفاً گزارش اجرا را ثبت کنید: {لینک}' + SIGN, 'مهلت مصوبه {شماره_مصوبه} گذشته است'),
    'resolution.reviewed': ev(null, null),
    'referral.created': ev(null, '{نام} گرامی،\n\n{عنوان}\n{متن}\n\n{لینک}' + SIGN),
    'referral.answered': ev(null, null),
    'network.resolution_shared': ev(null, null),
    'network.endorsed': ev(null, null),
    'network.proposal_national': ev(null, null),
    'network.proposal_updated': ev(null, null),
    'network.similar_found': ev(null, null),
  },
};

/** Fills missing parts of stored settings with the defaults. */
export function mergeNotificationSettings(stored: unknown): NotificationSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<NotificationSettings>;
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  const events = { ...d.events };
  for (const key of Object.keys(d.events) as NotificationEvent[]) {
    const e = (s.events as any)?.[key] ?? {};
    events[key] = {
      push: { ...d.events[key].push, ...(e.push ?? {}) },
      sms: { ...d.events[key].sms, ...(e.sms ?? {}) },
      email: { ...d.events[key].email, ...(e.email ?? {}) },
    };
  }
  return {
    publicUrl: s.publicUrl ?? d.publicUrl,
    sms: { ...d.sms, ...(s.sms ?? {}) },
    email: { ...d.email, ...(s.email ?? {}) },
    events,
  };
}
