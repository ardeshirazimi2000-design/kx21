/**
 * Persian names of the office automation (رسا) audit log: the stored action codes stay English (they are part of the
 * hash chain), only their display is Persian. Used by office-web to show the log and by office-api to search it in Persian.
 */
export const OFFICE_AUDIT_ACTIONS: Record<string, string> = {
  'auth.login': 'ورود به سامانه',
  'auth.login_failed': 'ورود ناموفق',
  'auth.mfa_enabled': 'فعال‌سازی ورود دومرحله‌ای',
  'auth.password_changed': 'تغییر رمز عبور',

  'letter.created': 'ایجاد نامه',
  'letter.updated': 'ویرایش نامه',
  'letter.registered': 'ثبت و شماره‌گذاری نامه',
  'letter.signed': 'امضای نامه',
  'letter.sent': 'ارسال نامه',
  'letter.delivered': 'تحویل نامه به گیرندگان',
  'letter.routed': 'ارجاع نامه',
  'letter.archived': 'بایگانی نامه',
  'letter.cancelled': 'ابطال نامه',
  'letter.attachment_added': 'افزودن پیوست به نامه',
  'letter.intake': 'دریافت نامه از درگاه ورودی',
  'letter.referred_to_meeting': 'ارجاع نامه به جلسه',
  'letter.created_from_resolution': 'ایجاد نامه از مصوبه جلسه',
  'letter.invitations_created': 'ایجاد دعوت‌نامه‌های جلسه',
  'routing.done': 'انجام ارجاع',
  'routing.returned': 'برگشت ارجاع',

  'letter_template.created': 'ایجاد قالب نامه',
  'letter_template.updated': 'ویرایش قالب نامه',
  'letter_template.deactivated': 'غیرفعال‌سازی قالب نامه',
  'letter_template.deleted': 'حذف قالب نامه',
  'letter_template.logo_set': 'بارگذاری لوگوی قالب نامه',
  'letter_template.logo_removed': 'حذف لوگوی قالب نامه',
  'letter_template.background_set': 'بارگذاری تصویر سربرگ',
  'letter_template.background_removed': 'حذف تصویر سربرگ',

  'workflow.definition_saved': 'ذخیره گردش کار',
  'workflow.definition_activated': 'فعال‌سازی گردش کار',
  'workflow.started': 'شروع گردش کار',
  'workflow.step.approve': 'تأیید گام گردش کار',
  'workflow.step.reject': 'رد گام گردش کار',
  'workflow.escalated': 'ارجاع خودکار به‌دلیل تأخیر',
  'workflow.completed': 'پایان گردش کار',
  'workflow.rejected': 'رد گردش کار',
  'workflow.cancelled': 'لغو گردش کار',
  'workflow.cancel_reason': 'علت لغو گردش کار',

  'document.created': 'ثبت سند در بایگانی',
  'document.updated': 'ویرایش سند بایگانی',
  'document.version_added': 'افزودن نسخه جدید سند',
  'document.signed': 'امضای سند',
  'document.disposed': 'امحای سند',
  'folder.created': 'ایجاد پوشه بایگانی',
  'folder.updated': 'ویرایش پوشه بایگانی',
  'retention.created': 'ایجاد سیاست نگهداری',
  'retention.updated': 'ویرایش سیاست نگهداری',

  'user.created': 'ایجاد کاربر',
  'user.updated': 'ویرایش کاربر',
  'user.signature_set': 'ثبت نمونه امضا',
  'user.signature_removed': 'حذف نمونه امضا',
  'role.created': 'ایجاد نقش',
  'role.updated': 'ویرایش نقش',
  'unit.created': 'ایجاد واحد سازمانی',
  'unit.updated': 'ویرایش واحد سازمانی',
  'position.created': 'ایجاد سمت',
  'position.updated': 'ویرایش سمت',
  'org_profile.updated': 'ویرایش مشخصات سازمان',
  'org_profile.logo_set': 'بارگذاری لوگوی سازمان',
  'org_profile.logo_removed': 'حذف لوگوی سازمان',

  'contact.created': 'افزودن مخاطب بیرونی',
  'contact.updated': 'ویرایش مخاطب بیرونی',
  'contact.deleted': 'حذف مخاطب بیرونی',
  'communications.extension_created': 'تخصیص شماره داخلی',
  'communications.extension_updated': 'تغییر شماره داخلی',
  'communications.extension_provision_requested': 'درخواست ایجاد داخلی در مرکز تلفن',
  'communications.extension_provisioned': 'ایجاد داخلی در مرکز تلفن',
  'communications.group_created': 'ایجاد گروه گفت‌وگو',
  'communications.group_updated': 'ویرایش گروه گفت‌وگو',
  'communications.members_added': 'افزودن عضو به گروه گفت‌وگو',
  'communications.member_removed': 'حذف عضو از گروه گفت‌وگو',
  'communications.member_left': 'خروج از گروه گفت‌وگو',
  'scanner.created': 'افزودن اسکنر',
  'scanner.updated': 'ویرایش اسکنر',
  'scanner.deleted': 'حذف اسکنر',
  'scanner.scanned': 'اسکن با اسکنر شبکه',
  'notification_template.updated': 'ویرایش قالب اعلان',

  'integration.configured': 'تنظیم اتصال به سامانه جلسات',
  'integration.intake_configured': 'تنظیم درگاه دریافت نامه',
  'integration.ai_configured': 'تنظیم هوش مصنوعی جستجو',
  'resolution.feedback_queued': 'ارسال بازخورد مصوبه به سامانه جلسات',
};

/** Persian names of what an audit record is about. */
export const OFFICE_AUDIT_ENTITIES: Record<string, string> = {
  letter: 'نامه',
  letter_template: 'قالب نامه',
  workflow_definition: 'تعریف گردش کار',
  workflow_instance: 'گردش کار',
  workflow_step: 'گام گردش کار',
  document: 'سند',
  archive_folder: 'پوشه بایگانی',
  retention_policy: 'سیاست نگهداری',
  user: 'کاربر',
  role: 'نقش',
  org_unit: 'واحد سازمانی',
  position: 'سمت',
  org_profile: 'مشخصات سازمان',
  contact: 'مخاطب بیرونی',
  communication_extension: 'شماره داخلی',
  communication_conversation: 'گفت‌وگوی پیام‌رسان',
  scanner: 'اسکنر',
  notification_template: 'قالب اعلان',
  integration: 'یکپارچه‌سازی',
  meeting: 'جلسه',
  resolution: 'مصوبه',
};

/** Persian name of an audit action; an unknown code (added later, or from an older version) is shown as is. */
export const officeAuditAction = (code: string): string => OFFICE_AUDIT_ACTIONS[code] ?? code;
export const officeAuditEntity = (code: string): string => OFFICE_AUDIT_ENTITIES[code] ?? code;

/** Action codes whose Persian name contains the text, so the log can be searched in Persian. */
export function officeAuditActionsMatching(text: string): string[] {
  const t = normalizeFa(text);
  if (!t) return [];
  return Object.entries(OFFICE_AUDIT_ACTIONS)
    .filter(([, label]) => normalizeFa(label).includes(t))
    .map(([code]) => code);
}

/** Arabic ي/ك to Persian ی/ک and half-spaces to spaces: «ثبت نامه» finds «ثبت‌نامه» and the other way round. */
const normalizeFa = (s: string) => s.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[‌\s]+/g, ' ').trim();
