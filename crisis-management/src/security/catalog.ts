/**
 * Permission catalogue and built-in roles of the urban crisis management system.
 * This is the single source of truth for the access matrix (see docs/security-profile.md).
 */

export type Scope = 'city' | 'district' | 'own';

export interface PermissionDef {
  key: string;
  title: string;
  group: 'access' | 'identity' | 'security' | 'operations';
  /**
   * Reserved permissions can only be held by locked built-in roles. Custom roles may not include them,
   * so `roles.manage` cannot be used to escalate privileges.
   */
  reserved?: boolean;
}

export const PERMISSIONS: PermissionDef[] = [
  { key: 'console.access', title: 'ورود به کنسول مدیریت', group: 'access' },
  { key: 'app.access', title: 'ورود به اپلیکیشن', group: 'access' },

  { key: 'users.read', title: 'مشاهده کاربران', group: 'identity', reserved: true },
  { key: 'users.create', title: 'تعریف کاربر (با احراز شاهکار)', group: 'identity', reserved: true },
  { key: 'users.update', title: 'ویرایش مشخصات کاربر', group: 'identity', reserved: true },
  { key: 'users.status', title: 'تعلیق / فعال‌سازی / بازگشایی قفل کاربر', group: 'identity', reserved: true },
  { key: 'users.assign_roles', title: 'تخصیص و سلب نقش', group: 'identity', reserved: true },
  { key: 'roles.read', title: 'مشاهده نقش‌ها و ماتریس دسترسی', group: 'identity' },
  { key: 'roles.manage', title: 'تعریف و ویرایش نقش‌ها', group: 'identity', reserved: true },
  { key: 'sessions.manage', title: 'مشاهده و ابطال نشست‌ها', group: 'identity', reserved: true },
  { key: 'shahkar.inquire', title: 'استعلام دستی شاهکار', group: 'identity', reserved: true },

  { key: 'shahkar.log.read', title: 'مشاهده سوابق استعلام شاهکار', group: 'security', reserved: true },
  { key: 'audit.read', title: 'مشاهده رخدادهای امنیتی (لاگ ممیزی)', group: 'security', reserved: true },
  { key: 'audit.configure', title: 'پیکربندی، خروجی و بایگانی ممیزی', group: 'security', reserved: true },
  { key: 'settings.read', title: 'مشاهده پیکربندی امنیتی', group: 'security' },
  { key: 'settings.manage', title: 'تغییر تنظیمات امنیتی (رمز، قفل، نشست، دسترسی شبکه)', group: 'security', reserved: true },
  { key: 'integrity.check', title: 'بررسی صحت داده‌ها و زنجیره ممیزی', group: 'security', reserved: true },

  { key: 'incidents.read', title: 'مشاهده حوادث', group: 'operations' },
  { key: 'incidents.report', title: 'ثبت گزارش مردمی / میدانی حادثه', group: 'operations' },
  { key: 'incidents.create', title: 'ثبت حادثه در اتاق عملیات', group: 'operations' },
  { key: 'incidents.update', title: 'ویرایش و تأیید حادثه', group: 'operations' },
  { key: 'incidents.declare', title: 'اعلام وضعیت بحران (فعال‌سازی)', group: 'operations' },
  { key: 'incidents.close', title: 'مهار و خاتمه حادثه', group: 'operations' },
  { key: 'tasks.read', title: 'مشاهده مأموریت‌ها', group: 'operations' },
  { key: 'tasks.assign', title: 'تخصیص مأموریت به نیروها', group: 'operations' },
  { key: 'tasks.update_own', title: 'به‌روزرسانی وضعیت مأموریت خود', group: 'operations' },
  { key: 'alerts.read', title: 'مشاهده هشدارها', group: 'operations' },
  { key: 'alerts.publish', title: 'انتشار هشدار عمومی', group: 'operations' },
  { key: 'reports.read', title: 'داشبورد و گزارش‌ها', group: 'operations' },
  { key: 'data.export', title: 'خروجی گرفتن از داده‌های حوادث', group: 'operations' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export const RESERVED_PERMISSIONS = new Set(PERMISSIONS.filter((p) => p.reserved).map((p) => p.key));

export interface RoleDef {
  key: string;
  title: string;
  description: string;
  scope: Scope;
  locked: boolean;
  staffOnly: boolean;
  permissions: string[];
}

const OPS_READ = ['incidents.read', 'tasks.read', 'alerts.read', 'reports.read'];

export const BUILTIN_ROLES: RoleDef[] = [
  {
    key: 'security_admin',
    title: 'مدیر امنیت و کاربران',
    description: 'تعریف کاربران با احراز شاهکار، تخصیص نقش، مدیریت نشست‌ها. به داده‌های عملیاتی دسترسی ندارد.',
    scope: 'city',
    locked: true,
    staffOnly: true,
    permissions: [
      'console.access', 'users.read', 'users.create', 'users.update', 'users.status', 'users.assign_roles',
      'roles.read', 'roles.manage', 'sessions.manage', 'shahkar.inquire', 'shahkar.log.read', 'settings.read', 'settings.manage',
    ],
  },
  {
    key: 'security_auditor',
    title: 'ممیز امنیتی',
    description: 'خواندن، پیکربندی، خروجی و بایگانی ممیزی؛ بررسی صحت داده‌ها؛ مشاهده سوابق شاهکار، کاربران و نقش‌ها.',
    scope: 'city',
    locked: true,
    staffOnly: true,
    permissions: ['console.access', 'audit.read', 'audit.configure', 'integrity.check', 'shahkar.log.read', 'users.read', 'roles.read', 'settings.read'],
  },
  {
    key: 'system_admin',
    title: 'مدیر فنی سامانه',
    description: 'پایش فنی و پیکربندی؛ بدون مجوز تعریف کاربر یا دسترسی به لاگ ممیزی.',
    scope: 'city',
    locked: false,
    staffOnly: true,
    permissions: ['console.access', 'roles.read', 'settings.read', 'reports.read'],
  },
  {
    key: 'crisis_director',
    title: 'مدیر بحران شهر (رئیس ستاد)',
    description: 'اعلام و خاتمه وضعیت بحران، انتشار هشدار، نظارت بر کل شهر.',
    scope: 'city',
    locked: false,
    staffOnly: true,
    permissions: [
      'console.access', 'app.access', ...OPS_READ, 'incidents.create', 'incidents.update',
      'incidents.declare', 'incidents.close', 'tasks.assign', 'alerts.publish', 'data.export',
    ],
  },
  {
    key: 'operations_chief',
    title: 'مسئول اتاق عملیات',
    description: 'هدایت عملیات، تأیید حوادث، تخصیص مأموریت و خاتمه حادثه.',
    scope: 'city',
    locked: false,
    staffOnly: true,
    permissions: [
      'console.access', 'app.access', ...OPS_READ, 'incidents.create', 'incidents.update',
      'incidents.close', 'tasks.assign', 'alerts.publish', 'data.export',
    ],
  },
  {
    key: 'operator',
    title: 'کارشناس اتاق عملیات',
    description: 'ثبت و به‌روزرسانی حوادث دریافتی.',
    scope: 'city',
    locked: false,
    staffOnly: true,
    permissions: ['console.access', ...OPS_READ, 'incidents.create', 'incidents.update'],
  },
  {
    key: 'district_coordinator',
    title: 'رابط مدیریت بحران منطقه',
    description: 'مدیریت حوادث و مأموریت‌ها فقط در منطقه خود.',
    scope: 'district',
    locked: false,
    staffOnly: true,
    permissions: ['console.access', 'app.access', ...OPS_READ, 'incidents.create', 'incidents.update', 'tasks.assign'],
  },
  {
    key: 'responder',
    title: 'نیروی عملیاتی (امدادگر)',
    description: 'از طریق اپلیکیشن: مشاهده و به‌روزرسانی مأموریت‌های خود، ثبت گزارش میدانی.',
    scope: 'own',
    locked: false,
    staffOnly: true,
    permissions: ['app.access', 'incidents.read', 'incidents.report', 'tasks.read', 'tasks.update_own', 'alerts.read'],
  },
  {
    key: 'observer',
    title: 'ناظر',
    description: 'مشاهده فقط‌خواندنی وضعیت عملیات (مثلاً نمایندگان دستگاه‌های همکار).',
    scope: 'city',
    locked: false,
    staffOnly: true,
    permissions: ['console.access', ...OPS_READ],
  },
  {
    key: 'citizen',
    title: 'شهروند',
    description: 'ثبت‌نام خودکار از اپلیکیشن با شاهکار + OTP؛ گزارش حادثه و دریافت هشدار.',
    scope: 'own',
    locked: false,
    staffOnly: false,
    permissions: ['app.access', 'incidents.read', 'incidents.report', 'alerts.read'],
  },
];

/**
 * Separation of duties. Each account holds exactly one role (PP FMT_SMR.1.2, application note 19), so these pairs
 * are already exclusive; the list is kept for custom role design and documentation.
 */
export const MUTUALLY_EXCLUSIVE_ROLES: [string, string][] = [
  ['security_admin', 'security_auditor'],
  ['security_admin', 'crisis_director'],
  ['security_admin', 'operations_chief'],
];

export const SCOPE_RANK: Record<Scope, number> = { own: 1, district: 2, city: 3 };

export function permissionTitle(key: string): string {
  return PERMISSIONS.find((p) => p.key === key)?.title ?? key;
}
