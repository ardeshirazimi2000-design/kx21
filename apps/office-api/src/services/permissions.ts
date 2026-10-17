/** Permission catalogue (RBAC). Roles map to these keys; a role assignment can be limited to a unit subtree. */
export const PERMISSIONS = [
  { key: 'letter.create', name: 'ایجاد پیش‌نویس و نامه داخلی', module: 'مکاتبات' },
  { key: 'letter.register_incoming', name: 'ثبت نامه وارده', module: 'مکاتبات' },
  { key: 'letter.register_outgoing', name: 'ثبت و شماره‌گذاری نامه صادره', module: 'مکاتبات' },
  { key: 'letter.read_all', name: 'مشاهده همه نامه‌های حوزه', module: 'مکاتبات' },
  { key: 'letter.sign', name: 'امضای نامه', module: 'مکاتبات' },
  { key: 'letter.send', name: 'ارسال نامه صادره', module: 'مکاتبات' },
  { key: 'letter.cancel', name: 'ابطال نامه', module: 'مکاتبات' },
  { key: 'signatures.manage', name: 'معرفی و ثبت نمونه امضای اشخاص', module: 'مکاتبات' },
  { key: 'workflow.start', name: 'شروع گردش کار', module: 'گردش کار' },
  { key: 'workflow.manage', name: 'طراحی و نسخه‌بندی گردش کار', module: 'گردش کار' },
  { key: 'archive.read', name: 'مشاهده بایگانی حوزه', module: 'بایگانی' },
  { key: 'archive.manage', name: 'مدیریت پرونده‌ها و اسناد', module: 'بایگانی' },
  { key: 'archive.dispose', name: 'امحای اسناد', module: 'بایگانی' },
  { key: 'org.manage', name: 'مدیریت ساختار سازمانی', module: 'کاربران' },
  { key: 'users.manage', name: 'مدیریت کاربران', module: 'کاربران' },
  { key: 'roles.manage', name: 'مدیریت نقش‌ها و مجوزها', module: 'کاربران' },
  { key: 'notifications.manage', name: 'مدیریت قالب‌های اعلان', module: 'اعلان‌ها' },
  { key: 'reports.view', name: 'مشاهده گزارش‌ها و داشبورد', module: 'گزارش‌گیری' },
  { key: 'audit.view', name: 'مشاهده رویدادنگاری', module: 'امنیت' },
  { key: 'integration.manage', name: 'تنظیم یکپارچه‌سازی', module: 'یکپارچه‌سازی' },
  { key: 'meetings.view', name: 'مشاهده جلسات و مصوبات', module: 'یکپارچه‌سازی' },
  { key: 'meetings.refer', name: 'ارجاع مکاتبه به کمیسیون/جلسه', module: 'یکپارچه‌سازی' },
  { key: 'resolutions.follow', name: 'ثبت پیگیری اجرای مصوبه', module: 'یکپارچه‌سازی' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

const all = PERMISSIONS.map((p) => p.key);
const pick = (...keys: Permission[]) => keys;

/** Built-in roles (editable later in the roles page). */
export const SYSTEM_ROLES: { key: string; name: string; description: string; permissions: Permission[] }[] = [
  { key: 'admin', name: 'مدیر سیستم', description: 'مدیریت کاربران، امنیت و تنظیمات', permissions: all },
  {
    key: 'secretariat',
    name: 'دبیرخانه',
    description: 'ثبت، شماره‌گذاری، ارسال و بایگانی مکاتبات',
    permissions: pick(
      'letter.create', 'letter.register_incoming', 'letter.register_outgoing', 'letter.read_all', 'letter.send', 'letter.cancel',
      'signatures.manage', 'workflow.start', 'archive.read', 'archive.manage', 'meetings.view', 'meetings.refer',
    ),
  },
  {
    key: 'manager',
    name: 'مدیر واحد',
    description: 'تأیید، ارجاع، امضا و نظارت در حوزه واحد',
    permissions: pick('letter.create', 'letter.read_all', 'letter.sign', 'workflow.start', 'archive.read', 'reports.view', 'meetings.view', 'meetings.refer', 'resolutions.follow'),
  },
  {
    key: 'president',
    name: 'رئیس اتاق / معاون',
    description: 'امضا و داشبورد مدیریتی',
    permissions: pick('letter.create', 'letter.read_all', 'letter.sign', 'workflow.start', 'archive.read', 'reports.view', 'meetings.view', 'meetings.refer', 'resolutions.follow'),
  },
  {
    key: 'expert',
    name: 'کارشناس',
    description: 'پردازش مکاتبات و اسناد ارجاع‌شده',
    permissions: pick('letter.create', 'workflow.start', 'meetings.view', 'resolutions.follow'),
  },
  { key: 'it', name: 'واحد فناوری اطلاعات', description: 'نگهداری و یکپارچه‌سازی', permissions: pick('integration.manage', 'audit.view', 'reports.view', 'meetings.view') },
];
