/**
 * Runtime security settings (PP: FMT_SMF.1, FMT_MOF.1, FMT_MTD.1).
 * Defaults come from the environment; authorised administrators override them from the console.
 * Audit-related keys are managed by the auditor (audit.configure), the rest by the security administrator
 * (settings.manage) — so nobody can both weaken auditing and act unaudited.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { pool, query, type Db } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

const cidr = z.string().trim().regex(/^[0-9a-fA-F:.]+\/\d{1,3}$|^[0-9a-fA-F:.]+$/, 'آدرس/شبکه IP نامعتبر است');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'قالب ساعت HH:MM');

export const SETTING_SCHEMAS = {
  'password.minLength': z.number().int().min(8).max(64),
  'password.maxAgeDays': z.number().int().min(0).max(365),
  'password.history': z.number().int().min(0).max(24),
  'lockout.threshold': z.number().int().min(3).max(20),
  'lockout.minutes': z.number().int().min(1).max(1440),
  'lockout.progressive': z.boolean(),
  'otp.ttlSec': z.number().int().min(60).max(600),
  'otp.maxAttempts': z.number().int().min(1).max(10),
  'sessions.maxConsole': z.number().int().min(1).max(5),
  'sessions.maxApp': z.number().int().min(1).max(10),
  'sessions.limitAction': z.enum(['replace', 'deny']),
  'sessions.consoleIdleMinutes': z.number().int().min(1).max(240),
  'sessions.appIdleDays': z.number().int().min(1).max(90),
  'sessions.bindIpConsole': z.boolean(),
  'sessions.bindIpApp': z.boolean(),
  'sessions.bindUserAgent': z.boolean(),
  'access.consoleCidrs': z.array(cidr).max(100),
  'access.consoleHours': z.object({ from: hhmm, to: hhmm }),
  'access.consoleDays': z.array(z.number().int().min(0).max(6)).min(1).max(7),
  'shahkar.reverifyDays': z.number().int().min(1).max(730),
  'shahkar.onNewDevice': z.boolean(),
  'app.citizenSignup': z.boolean(),
  'export.enabled': z.boolean(),
  'export.maxRows': z.number().int().min(1).max(100000),
  'integrity.checkMinutes': z.number().int().min(5).max(1440),
  'audit.disabledEvents': z.array(z.string().max(64)).max(50),
  'audit.warnRows': z.number().int().min(1000),
  'audit.maxRows': z.number().int().min(1000),
  'audit.fullAction': z.enum(['block', 'alert']),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const DEFAULTS: Settings = {
  'password.minLength': config.PASSWORD_MIN_LENGTH,
  'password.maxAgeDays': config.PASSWORD_MAX_AGE_DAYS,
  'password.history': 5,
  'lockout.threshold': config.LOGIN_MAX_FAILURES,
  'lockout.minutes': config.LOCKOUT_MINUTES,
  'lockout.progressive': true,
  'otp.ttlSec': config.OTP_TTL_SEC,
  'otp.maxAttempts': config.OTP_MAX_ATTEMPTS,
  'sessions.maxConsole': 1,
  'sessions.maxApp': 2,
  'sessions.limitAction': 'replace',
  'sessions.consoleIdleMinutes': Math.round(config.CONSOLE_IDLE_TIMEOUT_SEC / 60),
  'sessions.appIdleDays': 14,
  'sessions.bindIpConsole': true,
  'sessions.bindIpApp': false,
  'sessions.bindUserAgent': true,
  'access.consoleCidrs': [],
  'access.consoleHours': { from: '00:00', to: '23:59' },
  'access.consoleDays': [0, 1, 2, 3, 4, 5, 6],
  'shahkar.reverifyDays': config.SHAHKAR_REVERIFY_DAYS,
  'shahkar.onNewDevice': config.SHAHKAR_ON_NEW_DEVICE,
  'app.citizenSignup': config.APP_CITIZEN_SIGNUP,
  'export.enabled': true,
  'export.maxRows': 5000,
  'integrity.checkMinutes': 60,
  'audit.disabledEvents': [],
  'audit.warnRows': 4_000_000,
  'audit.maxRows': 5_000_000,
  'audit.fullAction': 'block',
};

export const SETTING_TITLES: Record<SettingKey, string> = {
  'password.minLength': 'حداقل طول رمز عبور',
  'password.maxAgeDays': 'حداکثر عمر رمز (روز، ۰ = نامحدود)',
  'password.history': 'تعداد رمزهای قبلی غیرقابل تکرار',
  'lockout.threshold': 'آستانه تلاش ناموفق احراز هویت',
  'lockout.minutes': 'مدت قفل حساب (دقیقه)',
  'lockout.progressive': 'دو برابر شدن مدت قفل در قفل‌های متوالی',
  'otp.ttlSec': 'اعتبار کد یکبارمصرف (ثانیه)',
  'otp.maxAttempts': 'حداکثر تلاش برای هر کد یکبارمصرف',
  'sessions.maxConsole': 'حداکثر نشست همزمان کنسول برای هر کاربر',
  'sessions.maxApp': 'حداکثر نشست همزمان اپ برای هر کاربر',
  'sessions.limitAction': 'اقدام در صورت عبور از سقف نشست (replace: ابطال قدیمی‌ترین / deny: رد نشست جدید)',
  'sessions.consoleIdleMinutes': 'خاتمه نشست کنسول پس از عدم فعالیت (دقیقه)',
  'sessions.appIdleDays': 'خاتمه نشست اپ پس از عدم فعالیت (روز)',
  'sessions.bindIpConsole': 'مقید بودن نشست کنسول به آدرس IP',
  'sessions.bindIpApp': 'مقید بودن نشست اپ به آدرس IP',
  'sessions.bindUserAgent': 'مقید بودن نشست به مرورگر/برنامه کاربر',
  'access.consoleCidrs': 'شبکه‌های مجاز برای ورود به کنسول (خالی = همه)',
  'access.consoleHours': 'بازه ساعت مجاز ورود به کنسول (به وقت تهران)',
  'access.consoleDays': 'روزهای مجاز ورود به کنسول (۰ = یکشنبه … ۶ = شنبه)',
  'shahkar.reverifyDays': 'دوره استعلام مجدد شاهکار (روز)',
  'shahkar.onNewDevice': 'استعلام شاهکار در ورود از دستگاه جدید',
  'app.citizenSignup': 'ثبت‌نام شهروند از اپلیکیشن',
  'export.enabled': 'امکان خروجی گرفتن از داده‌ها',
  'export.maxRows': 'حداکثر رکورد در هر خروجی',
  'integrity.checkMinutes': 'فاصله بررسی خودکار صحت داده‌ها (دقیقه)',
  'audit.disabledEvents': 'رویدادهای غیرضروری غیرفعال در ممیزی',
  'audit.warnRows': 'آستانه هشدار حجم ممیزی (تعداد رکورد)',
  'audit.maxRows': 'ظرفیت ممیزی (تعداد رکورد)',
  'audit.fullAction': 'اقدام هنگام پر شدن ممیزی (block: توقف فعالیت کاربران غیرمدیر / alert: فقط هشدار)',
};

/** Settings managed by the auditor; all others by the security administrator. */
export function settingPermission(key: SettingKey): 'audit.configure' | 'settings.manage' {
  return key.startsWith('audit.') ? 'audit.configure' : 'settings.manage';
}

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(db: Db = pool): Promise<Settings> {
  if (cache && Date.now() - cache.at < 2000) return cache.value;
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM security_settings', [], db);
  const value = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) {
    const schema = SETTING_SCHEMAS[r.key as SettingKey];
    if (schema?.safeParse(r.value).success) value[r.key] = r.value;
  }
  cache = { at: Date.now(), value: value as Settings };
  return cache.value;
}

export function invalidateSettings() {
  cache = null;
}

/** Validates and stores one setting; returns the previous value. */
export async function setSetting(db: Db, key: string, value: unknown, actorId: string): Promise<{ before: unknown; after: unknown }> {
  const schema = SETTING_SCHEMAS[key as SettingKey];
  if (!schema) throw badRequest(`تنظیم ناشناخته: ${key}`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(`مقدار نامعتبر برای «${SETTING_TITLES[key as SettingKey]}»: ${parsed.error.issues.map((i) => i.message).join('، ')}`);
  const current = await getSettings(db);
  if (key === 'audit.warnRows' && (parsed.data as number) >= current['audit.maxRows']) throw badRequest('آستانه هشدار باید کمتر از ظرفیت باشد');
  if (key === 'audit.maxRows' && (parsed.data as number) <= current['audit.warnRows']) throw badRequest('ظرفیت باید بیشتر از آستانه هشدار باشد');
  await db.query(
    `INSERT INTO security_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(parsed.data), actorId],
  );
  invalidateSettings();
  return { before: current[key as SettingKey], after: parsed.data };
}
