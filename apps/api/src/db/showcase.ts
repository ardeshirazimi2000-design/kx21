/**
 * Showcase data (اطلاعات ارائه) for a presentation server: six provincial chambers, three commissions each,
 * a national coordinator and thematic networks — built through the system's own API, so every meeting,
 * vote, minutes, resolution, progress report, endorsement and national proposal passes the same rules and
 * leaves the same records (audit log, notifications, versions) as real use.
 *
 * Only for an EMPTY install: it refuses a database that already holds a chamber or any user other than a
 * super admin, so it can never mix demo records into real data.
 *
 *   ALLOW_DEMO_SEED=1 node dist/db/showcase.js   (SHOWCASE_PASSWORD for the demo accounts; ROOT_PASSWORD for root when
 *   no super admin exists yet — normally create-admin.js has made one)
 */
import bcrypt from 'bcryptjs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COMMISSION_SETTINGS, toJalali } from '@kx/shared';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { signAccessToken } from '../auth/tokens.js';
import { migrate } from './migrate.js';
import { one, pool, query } from './pool.js';

export const SHOWCASE_PASSWORD = 'Demo@1405';
const DOMAIN = 'demo.ir';
const TERM_START = '2023-04-21';

// ─────────────────────────────── Content ───────────────────────────────

interface Province {
  code: string;
  province: string;
  city: string;
  phone: string;
  third: Theme;
}
type Theme = 'AGR' | 'EXP' | 'ENR' | 'TUR' | 'IND' | 'TRN';

const PROVINCES: Province[] = [
  { code: 'yzd', province: 'یزد', city: 'یزد', phone: '035', third: 'ENR' },
  { code: 'shz', province: 'فارس', city: 'شیراز', phone: '071', third: 'TUR' },
  { code: 'isf', province: 'اصفهان', city: 'اصفهان', phone: '031', third: 'IND' },
  { code: 'snd', province: 'کردستان', city: 'سنندج', phone: '087', third: 'TUR' },
  { code: 'tbz', province: 'آذربایجان شرقی', city: 'تبریز', phone: '041', third: 'IND' },
  { code: 'thr', province: 'تهران', city: 'تهران', phone: '021', third: 'TRN' },
];

interface MeetingPlan {
  title: string;
  items: { title: string; summary: string; decision: string }[];
  resolutions: string[];
}
interface ThemeContent {
  name: string;
  domain: string;
  bodies: string[];
  meetings: MeetingPlan[]; // three from the archive, then the live one, then the upcoming one
  issue: string;
}

const THEMES: Record<Theme, ThemeContent> = {
  AGR: {
    name: 'کمیسیون کشاورزی، آب و صنایع غذایی',
    domain: 'کشاورزی، آب، صنایع تبدیلی و غذایی',
    bodies: ['سازمان جهاد کشاورزی استان', 'گمرک استان', 'اداره کل استاندارد استان', 'بانک کشاورزی استان', 'شرکت آب منطقه‌ای'],
    issue: 'کمبود سردخانه و ضایعات بالای محصولات باغی در فصل برداشت',
    meetings: [
      {
        title: 'بررسی وضعیت صادرات محصولات کشاورزی {استان}',
        items: [
          { title: 'گزارش وضعیت صادرات محصولات باغی در سال جاری', summary: 'دبیر گزارش کاهش صادرات محصولات باغی را ارائه کرد و اعضا علت را محدودیت حمل یخچال‌دار و تأخیر در صدور گواهی بهداشت دانستند.', decision: 'مقرر شد مکاتبه با سازمان جهاد کشاورزی برای تسریع صدور گواهی‌ها انجام شود.' },
          { title: 'مشکلات تأمین نهاده‌های دامی', summary: 'اعضا دربارهٔ تأخیر در تخصیص ارز نهاده‌ها و افزایش قیمت در بازار آزاد بحث کردند.', decision: 'گزارش مشکلات به معاونت اقتصادی استانداری ارسال شود.' },
        ],
        resolutions: ['پیگیری تسریع صدور گواهی بهداشت و قرنطینهٔ محصولات باغی صادراتی {استان} از طریق استقرار باجهٔ مشترک در گمرک'],
      },
      {
        title: 'ظرفیت‌های صنایع تبدیلی و بسته‌بندی',
        items: [
          { title: 'ارائهٔ طرح خوشهٔ صنایع تبدیلی استان', summary: 'کارشناس اتاق ظرفیت خالی واحدهای تبدیلی را حدود ۳۵ درصد برآورد کرد.', decision: 'طرح برای تصویب در شورای گفت‌وگوی دولت و بخش خصوصی آماده شود.' },
          { title: 'تسهیلات سرمایه در گردش واحدهای کشاورزی', summary: 'اعضا خواستار تمدید مهلت بازپرداخت تسهیلات خسارت‌دیدگان خشکسالی شدند.', decision: 'مکاتبه با بانک کشاورزی انجام شود.' },
        ],
        resolutions: [
          'تهیهٔ بستهٔ حمایتی برای ایجاد واحدهای سردخانه و بسته‌بندی در مناطق تولید محصولات باغی {استان}',
          'درخواست تمدید شش‌ماههٔ مهلت بازپرداخت تسهیلات کشاورزان خسارت‌دیده از خشکسالی',
        ],
      },
      {
        title: 'بهره‌وری آب در کشاورزی',
        items: [
          { title: 'گزارش اجرای طرح‌های آبیاری نوین', summary: 'نمایندهٔ جهاد کشاورزی پیشرفت طرح‌های آبیاری تحت فشار را ارائه کرد.', decision: 'پیشنهاد اولویت‌دادن به تسهیلات آبیاری نوین در بودجهٔ استانی تصویب شد.' },
          { title: 'الگوی کشت متناسب با منابع آب', summary: 'اعضا بر لزوم مشارکت تشکل‌های بهره‌بردار در تدوین الگوی کشت تأکید کردند.', decision: 'کارگروه مشترک تشکیل شود.' },
        ],
        resolutions: ['تشکیل کارگروه مشترک اتاق و جهاد کشاورزی برای تدوین الگوی کشت متناسب با منابع آب {استان}'],
      },
      {
        title: 'موانع صادرات محصولات کشاورزی به کشورهای همسایه',
        items: [
          { title: 'مشکلات صادرات به عراق و کشورهای حاشیهٔ خلیج فارس', summary: 'اعضا تأخیر در مرزها، نبود ناوگان یخچال‌دار و الزام‌های جدید استاندارد کشورهای مقصد را مهم‌ترین موانع دانستند.', decision: 'پیشنهاد ایجاد مرکز تجمیع صادرات محصولات کشاورزی به رأی گذاشته شد.' },
          { title: 'نیاز به مطالعهٔ بازارهای هدف', summary: 'اعضا خواستار مطالعهٔ کارشناسی بازارهای هدف شدند.', decision: 'موضوع به کارشناس کمیسیون ارجاع شد.' },
        ],
        resolutions: ['ایجاد مرکز تجمیع و صدور گواهی‌های صادراتی محصولات کشاورزی با مشارکت گمرک، استاندارد و جهاد کشاورزی در {استان}'],
      },
      {
        title: 'برنامهٔ حمایت از صادرات محصولات کشاورزی در فصل برداشت',
        items: [
          { title: 'گزارش دبیر از پیگیری مصوبات جلسات قبل', summary: '', decision: '' },
          { title: 'برنامهٔ صادرات محصولات باغی فصل جاری', summary: '', decision: '' },
          { title: 'هماهنگی با شبکهٔ ملی کمیسیون‌های کشاورزی', summary: '', decision: '' },
        ],
        resolutions: [],
      },
    ],
  },
  EXP: {
    name: 'کمیسیون تجارت، صادرات و توسعهٔ بازار',
    domain: 'صادرات، گمرک، تجارت خارجی و بازاریابی بین‌المللی',
    bodies: ['گمرک استان', 'سازمان صنعت، معدن و تجارت استان', 'بانک مرکزی (شعبهٔ استان)', 'سازمان توسعهٔ تجارت ایران', 'اداره کل امور مالیاتی استان'],
    issue: 'طولانی‌شدن فرایند رفع تعهد ارزی صادرکنندگان خرد',
    meetings: [
      {
        title: 'بررسی مشکلات رفع تعهد ارزی صادرکنندگان',
        items: [
          { title: 'گزارش مشکلات صادرکنندگان خرد در رفع تعهد ارزی', summary: 'اعضا گزارش دادند که بخشی از صادرکنندگان خرد به‌دلیل تأخیر در سامانهٔ نیما از خدمات گمرکی محروم شده‌اند.', decision: 'مکاتبه با بانک مرکزی برای سازوکار ویژهٔ صادرکنندگان خرد انجام شود.' },
          { title: 'استرداد حقوق ورودی مواد اولیهٔ صادراتی', summary: 'دبیر روند کند استرداد را تشریح کرد.', decision: 'پیگیری از گمرک استان انجام شود.' },
        ],
        resolutions: ['درخواست از بانک مرکزی برای تعیین سازوکار ویژهٔ رفع تعهد ارزی صادرکنندگان خرد {استان}'],
      },
      {
        title: 'توسعهٔ بازارهای صادراتی',
        items: [
          { title: 'برنامهٔ حضور در نمایشگاه‌های خارجی', summary: 'اعضا بر حضور هدفمند در نمایشگاه‌های کشورهای همسایه تأکید کردند.', decision: 'تقویم نمایشگاهی سال آینده تدوین شود.' },
          { title: 'راه‌اندازی مرکز تجاری در کشورهای هدف', summary: 'ایدهٔ مرکز تجاری مشترک استانی مطرح شد.', decision: 'امکان‌سنجی به کارشناس سپرده شد.' },
        ],
        resolutions: ['تدوین تقویم مشترک حضور صادرکنندگان {استان} در نمایشگاه‌های بین‌المللی کشورهای همسایه'],
      },
      {
        title: 'تسهیل تجارت و کاهش زمان ترخیص',
        items: [
          { title: 'زمان ترخیص کالا در گمرکات استان', summary: 'میانگین زمان ترخیص ۹ روز گزارش شد.', decision: 'پیشنهاد استقرار پنجرهٔ واحد مرزی تصویب شد.' },
          { title: 'مسیر سبز گمرکی برای صادرکنندگان نمونه', summary: 'اعضا خواستار گسترش مسیر سبز شدند.', decision: 'مکاتبه با گمرک ایران انجام شود.' },
        ],
        resolutions: [
          'پیگیری استقرار پنجرهٔ واحد تجارت فرامرزی در گمرکات {استان} برای کاهش زمان ترخیص',
          'درخواست گسترش مسیر سبز گمرکی برای صادرکنندگان نمونهٔ استان',
        ],
      },
      {
        title: 'کاهش هزینه‌های حمل‌ونقل صادراتی',
        items: [
          { title: 'افزایش کرایهٔ حمل جاده‌ای و ریلی', summary: 'اعضا افزایش ۴۰ درصدی کرایهٔ حمل را مهم‌ترین مانع رقابت‌پذیری دانستند.', decision: 'پیشنهاد اختصاص یارانهٔ حمل به صادرات به رأی گذاشته شد.' },
          { title: 'نیاز به مطالعهٔ بازار کشورهای آسیای میانه', summary: 'موضوع برای بررسی کارشناسی مطرح شد.', decision: 'به کارشناس کمیسیون ارجاع شد.' },
        ],
        resolutions: ['پیشنهاد اختصاص بخشی از منابع صندوق توسعهٔ صادرات به جبران هزینهٔ حمل کالاهای صادراتی {استان}'],
      },
      {
        title: 'برنامهٔ صادراتی نیمهٔ دوم سال',
        items: [
          { title: 'گزارش دبیر از پیگیری مصوبات', summary: '', decision: '' },
          { title: 'هدف‌گذاری صادرات غیرنفتی استان', summary: '', decision: '' },
          { title: 'گزارش شبکهٔ ملی تجارت و صادرات', summary: '', decision: '' },
        ],
        resolutions: [],
      },
    ],
  },
  ENR: {
    name: 'کمیسیون انرژی، آب و محیط زیست',
    domain: 'انرژی، آب، انرژی‌های تجدیدپذیر و محیط زیست',
    bodies: ['شرکت توزیع نیروی برق استان', 'شرکت آب منطقه‌ای', 'اداره کل حفاظت محیط زیست', 'سازمان انرژی‌های تجدیدپذیر و بهره‌وری انرژی (ساتبا)'],
    issue: 'قطعی برق واحدهای صنعتی در ساعات اوج مصرف تابستان',
    meetings: [
      {
        title: 'مدیریت مصرف برق صنایع در تابستان',
        items: [
          { title: 'برنامهٔ محدودیت برق صنایع', summary: 'نمایندهٔ شرکت توزیع برنامهٔ محدودیت را تشریح کرد و اعضا خسارت توقف خطوط تولید را گزارش کردند.', decision: 'پیشنهاد جابه‌جایی ساعات کار صنایع به‌جای قطع کامل ارائه شود.' },
          { title: 'نیروگاه‌های خورشیدی پشت‌بامی', summary: 'ظرفیت نصب پنل خورشیدی در شهرک‌های صنعتی بررسی شد.', decision: 'شناسایی واحدهای متقاضی انجام شود.' },
        ],
        resolutions: ['پیشنهاد جابه‌جایی برنامه‌ریزی‌شدهٔ ساعات کار صنایع {استان} به‌جای قطع کامل برق در ساعات اوج'],
      },
      {
        title: 'انرژی‌های تجدیدپذیر',
        items: [
          { title: 'موانع سرمایه‌گذاری در نیروگاه خورشیدی', summary: 'تأخیر در پرداخت مطالبات خرید تضمینی برق مهم‌ترین مانع اعلام شد.', decision: 'مکاتبه با ساتبا انجام شود.' },
          { title: 'تأمین زمین برای نیروگاه‌ها', summary: 'اعضا دربارهٔ واگذاری اراضی ملی بحث کردند.', decision: 'پیگیری از منابع طبیعی انجام شود.' },
        ],
        resolutions: ['پیگیری پرداخت به‌موقع مطالبات خرید تضمینی برق نیروگاه‌های تجدیدپذیر بخش خصوصی {استان}'],
      },
      {
        title: 'بازچرخانی آب در صنایع',
        items: [
          { title: 'طرح تصفیه و بازچرخانی پساب صنعتی', summary: 'کارشناس طرح استفاده از پساب تصفیه‌شده در شهرک‌های صنعتی را ارائه کرد.', decision: 'طرح تأیید و برای تأمین مالی پیگیری شود.' },
          { title: 'آلودگی هوا و واحدهای صنعتی', summary: 'گزارش پایش آلاینده‌ها ارائه شد.', decision: 'جلسهٔ مشترک با محیط زیست برگزار شود.' },
        ],
        resolutions: ['حمایت از سرمایه‌گذاری بخش خصوصی در تصفیه و بازچرخانی پساب شهرک‌های صنعتی {استان}'],
      },
      {
        title: 'بهینه‌سازی مصرف انرژی در واحدهای صنعتی',
        items: [
          { title: 'ممیزی انرژی صنایع پرمصرف', summary: 'اعضا بر ضرورت ممیزی انرژی با مشوق مالیاتی تأکید کردند.', decision: 'پیشنهاد مشوق مالیاتی به رأی گذاشته شد.' },
          { title: 'مطالعهٔ ظرفیت انرژی بادی', summary: 'موضوع نیاز به بررسی کارشناسی دارد.', decision: 'به کارشناس ارجاع شد.' },
        ],
        resolutions: ['پیشنهاد اعطای مشوق مالیاتی به واحدهای صنعتی {استان} که ممیزی و بهینه‌سازی انرژی انجام می‌دهند'],
      },
      {
        title: 'آمادگی برای اوج مصرف زمستان',
        items: [
          { title: 'گزارش پیگیری مصوبات', summary: '', decision: '' },
          { title: 'تأمین گاز صنایع در زمستان', summary: '', decision: '' },
        ],
        resolutions: [],
      },
    ],
  },
  TUR: {
    name: 'کمیسیون گردشگری و صنایع‌دستی',
    domain: 'گردشگری، میراث فرهنگی، صنایع‌دستی و خدمات',
    bodies: ['اداره کل میراث فرهنگی، گردشگری و صنایع‌دستی', 'استانداری', 'شهرداری مرکز استان', 'اداره کل راه و شهرسازی'],
    issue: 'کمبود اقامتگاه استاندارد در فصل اوج سفر',
    meetings: [
      {
        title: 'توسعهٔ گردشگری {استان}',
        items: [
          { title: 'آمار سفر و اقامت نوروز', summary: 'آمار نشان‌دهندهٔ کمبود ظرفیت اقامتی در ایام اوج بود.', decision: 'حمایت از اقامتگاه‌های بوم‌گردی پیگیری شود.' },
          { title: 'بازاریابی گردشگری خارجی', summary: 'اعضا بر حضور در نمایشگاه‌های گردشگری منطقه تأکید کردند.', decision: 'بستهٔ معرفی استان تهیه شود.' },
        ],
        resolutions: ['پیگیری تسهیلات ویژهٔ احداث و بهسازی اقامتگاه‌های بوم‌گردی {استان}'],
      },
      {
        title: 'صنایع‌دستی و بازار فروش',
        items: [
          { title: 'فروش برخط صنایع‌دستی', summary: 'ایجاد بازارچهٔ برخط مشترک هنرمندان مطرح شد.', decision: 'طرح با همکاری اتاق اجرا شود.' },
          { title: 'بیمهٔ هنرمندان صنایع‌دستی', summary: 'مشکلات پوشش بیمه‌ای مطرح شد.', decision: 'مکاتبه با سازمان تأمین اجتماعی انجام شود.' },
        ],
        resolutions: ['راه‌اندازی بازارچهٔ برخط مشترک صنایع‌دستی {استان} با همکاری اتاق و میراث فرهنگی'],
      },
      {
        title: 'گردشگری سلامت و طبیعت',
        items: [
          { title: 'ظرفیت گردشگری سلامت', summary: 'بیمارستان‌های دارای مجوز پذیرش بیمار خارجی معرفی شدند.', decision: 'بستهٔ خدمات گردشگری سلامت تدوین شود.' },
          { title: 'زیرساخت مسیرهای طبیعت‌گردی', summary: 'نبود سرویس‌های رفاهی در مسیرها مطرح شد.', decision: 'پیگیری از استانداری انجام شود.' },
        ],
        resolutions: ['تدوین بستهٔ مشترک خدمات گردشگری سلامت {استان} برای بازارهای کشورهای همسایه'],
      },
      {
        title: 'رونق سفرهای خارجی به استان',
        items: [
          { title: 'پروازهای مستقیم خارجی', summary: 'اعضا برقراری پرواز مستقیم از کشورهای همسایه را ضروری دانستند.', decision: 'پیشنهاد مشوق برای ایرلاین‌ها به رأی گذاشته شد.' },
          { title: 'مطالعهٔ بازار گردشگران عراقی', summary: 'نیاز به بررسی کارشناسی دارد.', decision: 'به کارشناس ارجاع شد.' },
        ],
        resolutions: ['پیشنهاد مشوق‌های فرودگاهی برای برقراری پرواز مستقیم از کشورهای همسایه به {استان}'],
      },
      {
        title: 'برنامهٔ گردشگری نیمهٔ دوم سال',
        items: [
          { title: 'گزارش پیگیری مصوبات', summary: '', decision: '' },
          { title: 'برنامهٔ جشنوارهٔ صنایع‌دستی', summary: '', decision: '' },
        ],
        resolutions: [],
      },
    ],
  },
  IND: {
    name: 'کمیسیون صنعت، معدن و فناوری',
    domain: 'صنعت، معدن، شهرک‌های صنعتی و نوآوری',
    bodies: ['سازمان صنعت، معدن و تجارت استان', 'شرکت شهرک‌های صنعتی استان', 'اداره کل منابع طبیعی و آبخیزداری', 'سازمان تأمین اجتماعی استان'],
    issue: 'کمبود نقدینگی و سرمایه در گردش واحدهای صنعتی کوچک',
    meetings: [
      {
        title: 'مشکلات واحدهای صنعتی کوچک و متوسط',
        items: [
          { title: 'سرمایه در گردش واحدهای صنعتی', summary: 'اعضا کمبود نقدینگی را مشکل اول ۶۰ درصد واحدها دانستند.', decision: 'پیگیری تسهیلات تبصرهٔ ۱۸ انجام شود.' },
          { title: 'واحدهای راکد شهرک‌ها', summary: 'آمار واحدهای راکد ارائه شد.', decision: 'طرح احیای واحدهای راکد تهیه شود.' },
        ],
        resolutions: ['پیگیری تخصیص تسهیلات سرمایه در گردش به واحدهای صنعتی کوچک و متوسط {استان}'],
      },
      {
        title: 'معادن و فرآوری مواد معدنی',
        items: [
          { title: 'خام‌فروشی مواد معدنی', summary: 'اعضا بر لزوم تکمیل زنجیرهٔ فرآوری در استان تأکید کردند.', decision: 'مشوق‌های فرآوری پیشنهاد شود.' },
          { title: 'حقوق دولتی معادن', summary: 'افزایش حقوق دولتی مورد انتقاد قرار گرفت.', decision: 'مکاتبه با وزارت صمت انجام شود.' },
        ],
        resolutions: ['تدوین بستهٔ مشوق تکمیل زنجیرهٔ فرآوری مواد معدنی در {استان}'],
      },
      {
        title: 'فناوری و نوآوری در صنعت',
        items: [
          { title: 'همکاری صنعت و دانشگاه', summary: 'تجربهٔ موفق دفاتر ارتباط با صنعت ارائه شد.', decision: 'تفاهم‌نامه با دانشگاه‌های استان پیگیری شود.' },
          { title: 'شرکت‌های دانش‌بنیان', summary: 'حضور دانش‌بنیان‌ها در زنجیرهٔ تأمین صنایع بزرگ بررسی شد.', decision: 'نمایشگاه توانمندی‌ها برگزار شود.' },
        ],
        resolutions: ['انعقاد تفاهم‌نامهٔ همکاری اتاق با دانشگاه‌های {استان} برای حل مسائل فنی صنایع'],
      },
      {
        title: 'زیرساخت شهرک‌های صنعتی',
        items: [
          { title: 'تأمین آب و برق شهرک‌ها', summary: 'کمبود زیرساخت در شهرک‌های جدید گزارش شد.', decision: 'پیشنهاد اولویت بودجه‌ای به رأی گذاشته شد.' },
          { title: 'مطالعهٔ خوشه‌های صنعتی', summary: 'نیاز به بررسی کارشناسی دارد.', decision: 'به کارشناس ارجاع شد.' },
        ],
        resolutions: ['اولویت‌دادن به تکمیل زیرساخت آب و برق شهرک‌های صنعتی جدید {استان} در بودجهٔ استانی'],
      },
      {
        title: 'برنامهٔ حمایت از تولید',
        items: [
          { title: 'گزارش پیگیری مصوبات', summary: '', decision: '' },
          { title: 'برنامهٔ نمایشگاه توانمندی‌های صنعتی', summary: '', decision: '' },
        ],
        resolutions: [],
      },
    ],
  },
  TRN: {
    name: 'کمیسیون حمل‌ونقل و لجستیک',
    domain: 'حمل‌ونقل جاده‌ای، ریلی، هوایی و لجستیک',
    bodies: ['اداره کل راهداری و حمل‌ونقل جاده‌ای', 'شرکت راه‌آهن جمهوری اسلامی ایران', 'گمرک ایران', 'سازمان هواپیمایی کشوری'],
    issue: 'فرسودگی ناوگان حمل‌ونقل جاده‌ای کالا',
    meetings: [
      {
        title: 'نوسازی ناوگان حمل‌ونقل کالا',
        items: [
          { title: 'آمار فرسودگی ناوگان', summary: 'میانگین سن ناوگان باری بیش از ۲۰ سال گزارش شد.', decision: 'پیشنهاد تسهیلات نوسازی تهیه شود.' },
          { title: 'واردات کامیون کارکرده', summary: 'اعضا موافق آزادسازی مشروط بودند.', decision: 'مکاتبه با وزارت صمت انجام شود.' },
        ],
        resolutions: ['پیگیری تسهیلات نوسازی ناوگان حمل‌ونقل جاده‌ای کالا در {استان}'],
      },
      {
        title: 'توسعهٔ حمل ریلی کالا',
        items: [
          { title: 'سهم ریل در جابه‌جایی کالا', summary: 'سهم ریل کمتر از ۱۰ درصد اعلام شد.', decision: 'مشوق حمل ریلی پیشنهاد شود.' },
          { title: 'بنادر خشک', summary: 'ظرفیت بندر خشک استان بررسی شد.', decision: 'طرح توسعه پیگیری شود.' },
        ],
        resolutions: ['توسعهٔ بندر خشک و اتصال ریلی مراکز لجستیک {استان}'],
      },
      {
        title: 'لجستیک تجارت الکترونیک',
        items: [
          { title: 'مراکز توزیع شهری', summary: 'نبود مراکز توزیع مجهز مطرح شد.', decision: 'مکان‌یابی مراکز انجام شود.' },
          { title: 'استانداردهای انبارداری', summary: 'اعضا بر استانداردسازی انبارها تأکید کردند.', decision: 'دستورالعمل تهیه شود.' },
        ],
        resolutions: ['مکان‌یابی و احداث مراکز توزیع و لجستیک شهری با مشارکت بخش خصوصی در {استان}'],
      },
      {
        title: 'ترانزیت و کریدورهای بین‌المللی',
        items: [
          { title: 'سهم استان از ترانزیت کریدور شمال-جنوب', summary: 'اعضا ظرفیت خالی کریدور را گزارش کردند.', decision: 'پیشنهاد بستهٔ مشوق ترانزیت به رأی گذاشته شد.' },
          { title: 'مطالعهٔ بازار ترانزیت', summary: 'نیاز به بررسی کارشناسی دارد.', decision: 'به کارشناس ارجاع شد.' },
        ],
        resolutions: ['تدوین بستهٔ مشوق جذب ترانزیت کالا از کریدور شمال-جنوب برای {استان}'],
      },
      {
        title: 'برنامهٔ لجستیک نیمهٔ دوم سال',
        items: [
          { title: 'گزارش پیگیری مصوبات', summary: '', decision: '' },
          { title: 'هماهنگی با راه‌آهن', summary: '', decision: '' },
        ],
        resolutions: [],
      },
    ],
  },
};

const FIRST = ['علی', 'محمد', 'رضا', 'حسین', 'مهدی', 'امیر', 'سعید', 'مجید', 'حمید', 'جواد', 'مرتضی', 'بهرام', 'کامران', 'فرهاد', 'داوود', 'زهرا', 'فاطمه', 'مریم', 'سارا', 'نرگس', 'لیلا', 'الهام', 'سمیه', 'شیرین', 'مهسا'];
const LAST = ['رضایی', 'احمدی', 'محمدی', 'حسینی', 'کریمی', 'موسوی', 'جعفری', 'صادقی', 'نوری', 'رحیمی', 'کاظمی', 'هاشمی', 'قاسمی', 'عباسی', 'یزدانی', 'فرهادی', 'سلطانی', 'شریفی', 'نجفی', 'طاهری', 'مرادی', 'اکبری', 'زمانی', 'بهرامی', 'خسروی', 'ملکی', 'امینی', 'توکلی', 'فتحی', 'میرزایی'];
const TITLES = ['مهندس ', 'دکتر ', '', '', ''];
const ORGS = ['شرکت تولیدی', 'شرکت بازرگانی', 'گروه صنعتی', 'شرکت کشت و صنعت', 'شرکت صادراتی', 'تعاونی', 'شرکت خدمات'];
const ORG_NAMES = ['آریا', 'پارس', 'سپهر', 'البرز', 'زاگرس', 'کوثر', 'آفتاب', 'نگین', 'پیشگام', 'رهاورد', 'آسیا', 'مهر', 'سپاهان', 'کیان', 'نوین'];

// ─────────────────────────────── Helpers ───────────────────────────────

let base = '';
async function api<T = any>(userId: string, method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}/api${url}`, {
    method,
    headers: { authorization: `Bearer ${signAccessToken(userId)}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`${method} ${url} → ${r.status} ${text}`) as Error & { status: number; code?: string };
    e.status = r.status;
    try {
      e.code = JSON.parse(text).error?.code;
    } catch {
      /* not JSON */
    }
    throw e;
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** A small valid PDF standing for the scanned, signed paper minutes. */
function scanPdf(label: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${label}) Tj 0 -30 Td (Signed minutes - scanned copy, demo) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function uploadScan(userId: string, meetingId: string, label: string) {
  const form = new FormData();
  form.set('meetingId', meetingId);
  form.set('kind', 'minutes_scan');
  form.set('title', 'صورتجلسهٔ امضاشده (اسکن)');
  form.set('file', new Blob([scanPdf(label)], { type: 'application/pdf' }), 'minutes-scan.pdf');
  const r = await fetch(`${base}/api/documents`, { method: 'POST', headers: { authorization: `Bearer ${signAccessToken(userId)}` }, body: form });
  if (!r.ok) throw new Error(`upload → ${r.status} ${await r.text()}`);
}

const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
/** A working day (not Friday) the given number of days from today. */
function workday(offset: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (d.getDay() === 5) d.setDate(d.getDate() + (offset < 0 ? -1 : 1));
  return d;
}
const fill = (s: string, p: Province) => s.replaceAll('{استان}', p.province);

interface Commission {
  id: string;
  code: string;
  theme: Theme;
  province: Province;
  chamberId: string;
  chair: string;
  vice: string;
  secretary: string;
  members: string[];
  expert: string;
  shareable?: string; // a resolution of the live meeting, for the network
}

// ─────────────────────────────── Structure ───────────────────────────────

async function buildStructure(password: string, rootPassword: string) {
  const hash = await bcrypt.hash(password, 10);
  const c = await pool.connect();
  const commissions: Commission[] = [];
  let seq = 0;
  let nameSeq = 0;
  const people = new Set<string>();
  try {
    await c.query('BEGIN');
    let root = (await c.query(`SELECT id FROM users WHERE is_super_admin ORDER BY created_at LIMIT 1`)).rows[0]?.id as string | undefined;
    if (!root) {
      root = (
        await c.query(
          `INSERT INTO users (full_name, email, mobile, organization, password_hash, is_super_admin) VALUES ('مدیر سامانه', $1, '09100000000', 'اتاق ایران', $2, true) RETURNING id`,
          [`root@${DOMAIN}`, await bcrypt.hash(rootPassword, 10)],
        )
      ).rows[0].id;
    }
    const chambers: Record<string, string> = {};
    let coordinator = '';
    for (const [pi, p] of PROVINCES.entries()) {
      const ch = (
        await c.query(
          `INSERT INTO chambers (name, province, phone, email, address) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [`اتاق بازرگانی، صنایع، معادن و کشاورزی ${p.city}`, p.province, `${p.phone}-00000000`, `info@${p.code}.${DOMAIN}`, `${p.city} (اطلاعات نمایشی)`],
        )
      ).rows[0].id as string;
      chambers[p.code] = ch;
      const person = async (fullName: string, local: string, org: string) => {
        seq++;
        const mobile = `0915${pi + 1}${String(seq).padStart(6, '0')}`;
        return (
          await c.query(
            `INSERT INTO users (chamber_id, full_name, email, mobile, organization, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [ch, fullName, `${local}@${DOMAIN}`, mobile, org, hash],
          )
        ).rows[0].id as string;
      };
      const name = () => {
        for (;;) {
          const n = nameSeq++;
          const full = `${TITLES[n % TITLES.length]}${FIRST[(n * 7) % FIRST.length]} ${LAST[(n * 11 + pi) % LAST.length]}`;
          if (!people.has(full)) {
            people.add(full);
            return full;
          }
        }
      };
      const org = (n: number) => `${ORGS[n % ORGS.length]} ${ORG_NAMES[(n * 3 + pi) % ORG_NAMES.length]} ${p.city}`;
      const admin = await person(`مدیر اتاق ${p.city}`, `admin.${p.code}`, `دبیرخانهٔ اتاق ${p.city}`);
      await c.query('INSERT INTO chamber_admins (chamber_id, user_id) VALUES ($1,$2)', [ch, admin]);
      if (p.code === 'thr') coordinator = await person('هماهنگ‌کنندهٔ شبکه‌های ملی', 'coordinator', 'معاونت امور استان‌ها و تشکل‌ها');
      const term = (
        await c.query(`INSERT INTO terms (chamber_id, number, title, start_date, status) VALUES ($1, 10, 'دوره دهم', $2, 'active') RETURNING id`, [ch, TERM_START])
      ).rows[0].id;
      for (const theme of ['AGR', 'EXP', p.third] as Theme[]) {
        const t = THEMES[theme];
        const k = (
          await c.query(
            `INSERT INTO commissions (chamber_id, term_id, name, code, domain, settings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [ch, term, `${t.name} ${p.city}`, theme, t.domain, JSON.stringify(DEFAULT_COMMISSION_SETTINGS)],
          )
        ).rows[0].id as string;
        const tc = theme.toLowerCase();
        const mem = async (userId: string, position: string, hasVote: boolean) =>
          c.query(
            `INSERT INTO commission_memberships (chamber_id, commission_id, user_id, position, has_vote, start_date) VALUES ($1,$2,$3,$4,$5,$6)`,
            [ch, k, userId, position, hasVote, TERM_START],
          );
        const chair = await person(name(), `chair.${tc}.${p.code}`, org(seq));
        const vice = await person(name(), `vice.${tc}.${p.code}`, org(seq));
        const secretary = await person(name(), `secretary.${tc}.${p.code}`, `دبیرخانهٔ ${t.name}`);
        const expert = await person(name(), `expert.${tc}.${p.code}`, `معاونت بررسی‌های اقتصادی اتاق ${p.city}`);
        await mem(chair, 'chair', true);
        await mem(vice, 'vice_chair', true);
        await mem(secretary, 'secretary', false);
        const members: string[] = [];
        for (let i = 1; i <= 6; i++) {
          const m = await person(name(), `member${i}.${tc}.${p.code}`, org(seq));
          await mem(m, 'member', true);
          members.push(m);
        }
        await mem(expert, 'expert', false);
        commissions.push({ id: k, code: theme, theme, province: p, chamberId: ch, chair, vice, secretary, members, expert });
      }
    }
    await c.query('COMMIT');
    return { root: root!, coordinator, chambers, commissions };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

// ─────────────────────────────── Processes ───────────────────────────────

/** Meetings held before the system was used, entered from their paper minutes (ثبت از سوابق). */
async function archivalMeeting(k: Commission, plan: MeetingPlan, number: number, daysAgo: number, progress: number[]) {
  const sec = k.secretary;
  const date = ymd(workday(-daysAgo));
  const m = await api(sec, 'POST', '/meetings/archival', {
    commissionId: k.id, number, title: fill(plan.title, k.province), date, startTime: '10:00', endTime: '12:00', location: 'سالن جلسات اتاق', type: 'in_person',
  });
  await api(sec, 'POST', `/meetings/${m.id}/attendance/bulk`, { status: 'manual_present' });
  await api(sec, 'POST', `/meetings/${m.id}/attendance/${k.members[(number + 1) % 6]}/confirm`, { status: 'absent', reason: 'ثبت از سوابق' });
  await api(sec, 'POST', `/meetings/${m.id}/attendance/${k.members[(number + 3) % 6]}/confirm`, { status: 'excused', reason: 'ثبت از سوابق — مأموریت' });
  const items = [];
  for (const it of plan.items) {
    const item = await api(sec, 'POST', `/meetings/${m.id}/agenda`, { title: fill(it.title, k.province) });
    await api(sec, 'PATCH', `/agenda-items/${item.id}`, { discussionSummary: it.summary, decision: it.decision });
    items.push(item);
  }
  await api(sec, 'POST', `/agenda-items/${items[0].id}/vote/manual`, { yes: 6, no: 1, abstain: 0, passed: true });
  for (const [i, text] of plan.resolutions.entries()) {
    const t = THEMES[k.theme];
    const r = await api(sec, 'POST', '/resolutions', {
      commissionId: k.id, meetingId: m.id, agendaItemId: items[Math.min(i, items.length - 1)].id, text: fill(text, k.province),
      number: `${number}/${i + 1}`, ownerId: k.members[i % 6], priority: i ? 'normal' : 'high',
      dueDate: ymd(workday(-daysAgo + 60)),
      executors: [{ name: t.bodies[(number + i) % t.bodies.length], role: 'lead' }, { name: t.bodies[(number + i + 1) % t.bodies.length], role: 'partner' }],
    });
    const full = await api(sec, 'GET', `/resolutions/${r.id}`);
    for (const [j, ex] of (full.executors ?? []).entries()) {
      const pct = progress[(i + j) % progress.length];
      if (pct > 0) {
        await api(sec, 'PATCH', `/resolutions/${r.id}/executors/${ex.id}/progress`, {
          progress: pct, note: pct === 100 ? 'اقدام انجام و نتیجه طی نامه به اتاق اعلام شد.' : 'مکاتبه انجام شده و پیگیری ادامه دارد.',
        });
      }
    }
  }
  await uploadScan(sec, m.id, `${k.code}-${k.province.code.toUpperCase()} meeting ${number}`);
  await api(sec, 'POST', `/meetings/${m.id}/archival/finalize`, { regenerate: true });
}

const FINAL_STATE: Record<Theme, 'approved' | 'pending_approval' | 'minutes_draft'> = {
  AGR: 'approved', EXP: 'approved', ENR: 'pending_approval', TUR: 'minutes_draft', IND: 'pending_approval', TRN: 'approved',
};

/** A meeting run in the system from invitation to approved minutes, with check-in, live votes and a referral. */
async function liveMeeting(k: Commission, plan: MeetingPlan, number: number) {
  const { secretary: sec, chair } = k;
  const t = THEMES[k.theme];
  const start = new Date(Date.now() + 5 * 60_000);
  const m = await api(sec, 'POST', '/meetings', {
    commissionId: k.id, number, title: fill(plan.title, k.province), scheduledAt: start.toISOString(), durationMinutes: 120,
    location: 'سالن جلسات اتاق', type: 'hybrid', agenda: plan.items.map((i) => ({ title: fill(i.title, k.province) })), schedule: true, allowHoliday: true,
  });
  await api(sec, 'POST', `/meetings/${m.id}/invite`, {});
  await api(sec, 'POST', `/meetings/${m.id}/checkin/open`, {});
  for (const u of [chair, k.vice, sec, ...k.members.slice(0, 5)]) await api(u, 'POST', `/meetings/${m.id}/check-in`, { method: u === k.members[4] ? 'online' : 'web' });
  await api(sec, 'POST', `/meetings/${m.id}/attendance/${k.members[5]}/confirm`, { status: 'excused', reason: 'اعلام قبلی عضو — سفر کاری' });
  await api(chair, 'POST', `/meetings/${m.id}/start`, {});
  const detail = await api(sec, 'GET', `/meetings/${m.id}`);
  const [first, second] = detail.agenda;

  await api(chair, 'POST', `/meetings/${m.id}/agenda/${first.id}/activate`, {});
  await api(k.members[0], 'POST', `/agenda-items/${first.id}/comments`, { body: 'با این پیشنهاد موافقم؛ تجربهٔ استان‌های دیگر هم موفق بوده است.' });
  const vote = await api(chair, 'POST', `/agenda-items/${first.id}/vote/start`, { title: `تصویب: ${fill(plan.resolutions[0], k.province)}`.slice(0, 190) });
  const choices = ['yes', 'yes', 'yes', 'yes', 'no', 'abstain', 'yes'];
  for (const [i, u] of [chair, k.vice, ...k.members.slice(0, 5)].entries()) await api(u, 'POST', `/agenda-items/${first.id}/vote`, { choice: choices[i] });
  await api(chair, 'POST', `/agenda-items/${first.id}/vote/close`, {});
  await api(sec, 'POST', `/agenda-items/${first.id}/complete`, {
    status: 'done', discussionSummary: plan.items[0].summary, decision: plan.items[0].decision, proposedResolution: fill(plan.resolutions[0], k.province),
  });
  await api(chair, 'POST', `/meetings/${m.id}/agenda/${second.id}/activate`, {});
  await api(sec, 'POST', `/agenda-items/${second.id}/complete`, {
    status: 'referred', discussionSummary: plan.items[1].summary, decision: plan.items[1].decision,
    referral: { expertId: k.expert, request: `بررسی کارشناسی و ارائهٔ گزارش: ${fill(plan.items[1].title, k.province)}`, dueDate: ymd(workday(14)) },
  });
  await api(chair, 'POST', `/meetings/${m.id}/end`, {});

  // Resolution from the passed vote, with executive bodies and their reports.
  const r = await api(sec, 'POST', '/resolutions', {
    commissionId: k.id, meetingId: m.id, agendaItemId: first.id, voteSessionId: vote.id, text: fill(plan.resolutions[0], k.province),
    ownerId: k.members[1], dueDate: ymd(workday(45)), priority: 'high', kpi: 'ابلاغ رسمی و آغاز اجرا در دستگاه‌های مسئول',
    executors: [{ name: t.bodies[0], role: 'lead' }, { name: t.bodies[1], role: 'partner' }, { name: t.bodies[2], role: 'partner' }],
  });
  const full = await api(sec, 'GET', `/resolutions/${r.id}`);
  const pcts = [40, 25, 0];
  for (const [j, ex] of (full.executors ?? []).entries()) {
    if (pcts[j]) await api(k.members[1], 'PATCH', `/resolutions/${r.id}/executors/${ex.id}/progress`, { progress: pcts[j], note: 'نامهٔ ابلاغ مصوبه ارسال و جلسهٔ کارشناسی برگزار شد.' });
  }
  k.shareable = r.id;

  // The expert answers the referral.
  const ref = await one<{ id: string }>(`SELECT id FROM referrals WHERE commission_id = $1 ORDER BY created_at DESC LIMIT 1`, [k.id]);
  if (ref) await api(k.expert, 'POST', `/referrals/${ref.id}/answer`, { response: 'گزارش کارشناسی تهیه و پیوست شد؛ پیشنهاد می‌شود موضوع در جلسهٔ آینده با حضور نمایندگان دستگاه‌ها بررسی شود.' });

  // Minutes: left at different stages across commissions so every step can be shown.
  const minutes = await api(sec, 'GET', `/meetings/${m.id}/minutes`);
  const target = FINAL_STATE[k.theme];
  if (target === 'minutes_draft') return;
  await api(sec, 'POST', `/minutes/${minutes.id}/submit`, {});
  if (target === 'approved') await api(chair, 'POST', `/minutes/${minutes.id}/approve`, {});
}

/** The next meeting: invitations sent, agenda set. */
async function upcomingMeeting(k: Commission, plan: MeetingPlan, offset: number) {
  for (let extra = 0; extra < 10; extra++) {
    const d = workday(offset + extra);
    d.setHours(10, 0, 0, 0);
    try {
      const m = await api(k.secretary, 'POST', '/meetings', {
        commissionId: k.id, title: fill(plan.title, k.province), scheduledAt: d.toISOString(), durationMinutes: 90,
        location: 'سالن جلسات اتاق', type: 'hybrid', agenda: plan.items.map((i) => ({ title: fill(i.title, k.province) })), schedule: true,
      });
      await api(k.secretary, 'POST', `/meetings/${m.id}/invite`, {});
      await api(k.members[2], 'POST', `/meetings/${m.id}/rsvp`, { response: 'attending' }).catch(() => undefined);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== 'holiday') throw e;
    }
  }
}

// ─────────────────────────────── Networks ───────────────────────────────

async function buildNetworks(root: string, coordinator: string, commissions: Commission[]) {
  const nets = [
    { name: 'شبکهٔ ملی کمیسیون‌های کشاورزی و صنایع غذایی', description: 'کمیسیون‌های کشاورزی، آب و صنایع غذایی اتاق‌های استان‌ها', theme: 'AGR' as Theme },
    { name: 'شبکهٔ ملی تجارت و صادرات', description: 'کمیسیون‌های تجارت، صادرات و توسعهٔ بازار اتاق‌های استان‌ها', theme: 'EXP' as Theme },
    { name: 'شبکهٔ گردشگری و صنایع‌دستی', description: 'کمیسیون‌های گردشگری استان‌ها', theme: 'TUR' as Theme },
    { name: 'شبکهٔ صنعت، معدن و فناوری', description: 'کمیسیون‌های صنعت و معدن استان‌ها', theme: 'IND' as Theme },
  ];
  for (const n of nets) {
    const net = await api(root, 'POST', '/networks', { name: n.name, description: n.description, endorseThreshold: 3 });
    const members = commissions.filter((k) => k.theme === n.theme);
    for (const k of members) await api(root, 'POST', `/networks/${net.id}/commissions`, { commissionId: k.id });
    if (n.theme === 'AGR' || n.theme === 'EXP') await api(root, 'POST', `/networks/${net.id}/coordinators`, { userId: coordinator });

    // Each commission shares its newest resolution; the network endorses some of them.
    for (const k of members) {
      if (!k.shareable) continue;
      await api(k.secretary, 'POST', `/resolutions/${k.shareable}/share`, {
        note: 'این موضوع در استان‌های دیگر هم مطرح است؛ از کمیسیون‌های عضو شبکه درخواست حمایت داریم.',
      });
    }
    const endorse = async (owner: Commission, supporters: Commission[]) => {
      for (const s of supporters) {
        await api(s.secretary, 'POST', `/networks/${net.id}/resolutions/${owner.shareable}/endorsements`, {
          commissionId: s.id, comment: `کمیسیون ${s.province.city} نیز با این مشکل مواجه است و از پیشنهاد حمایت می‌کند.`,
        });
      }
    };
    if (members.length >= 4) {
      // Two resolutions reach the threshold and become national proposals; one gathers some support.
      await endorse(members[0], members.slice(1, 4));
      await endorse(members[1], [members[0], members[2], members[3], members[4] ?? members[3]].filter((x, i, a) => a.indexOf(x) === i));
      await endorse(members[2], [members[5] ?? members[0]]);
      const proposals = await query<{ resolution_id: string }>(`SELECT resolution_id FROM network_proposals WHERE network_id = $1 ORDER BY reached_at`, [net.id]);
      const [p1, p2] = proposals;
      if (p1) await api(coordinator, 'PATCH', `/networks/${net.id}/proposals/${p1.resolution_id}`, { status: 'forwarded', response: 'پیشنهاد در کمیسیون تخصصی اتاق ایران بررسی و برای وزارتخانهٔ مربوط ارسال شد.' });
      if (p2) await api(coordinator, 'PATCH', `/networks/${net.id}/proposals/${p2.resolution_id}`, { status: 'reviewing', response: 'در دستور کار کمیسیون تخصصی اتاق ایران قرار گرفت.' });
    } else if (members.length === 2) {
      await endorse(members[0], [members[1]]);
    }
  }
}

// ─────────────────────────────── Entry ───────────────────────────────

/** True when the database has nothing a showcase could collide with. */
export async function isEmptyInstall(): Promise<boolean> {
  const row = await one<{ chambers: number; users: number }>(
    `SELECT (SELECT count(*) FROM chambers)::int AS chambers, (SELECT count(*) FROM users WHERE NOT is_super_admin)::int AS users`,
  );
  return row!.chambers === 0 && row!.users === 0;
}

export async function showcase(opts: { password?: string; rootPassword?: string; log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const password = opts.password ?? SHOWCASE_PASSWORD;
  // Its accounts share one password: on a production install only when asked for explicitly (a presentation server).
  if (config.isProd && process.env.ALLOW_DEMO_SEED !== '1') {
    throw new Error('Refusing to load showcase data in production (its accounts share one password). Set ALLOW_DEMO_SEED=1 for a presentation server.');
  }
  await migrate(false);
  if (!(await isEmptyInstall())) {
    throw new Error('این پایگاه‌داده اطلاعات دارد؛ اطلاعات ارائه فقط روی نصب خالی ساخته می‌شود. (The database is not empty; showcase data is only built on an empty install.)');
  }
  const server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    log('ساختار: اتاق‌ها، دوره‌ها، کمیسیون‌ها و اعضا…');
    const { root, coordinator, commissions } = await buildStructure(password, opts.rootPassword ?? password);
    const [jy] = toJalali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    for (const y of [jy, jy + 1]) await api(root, 'POST', '/holidays/official', { year: y }).catch(() => undefined);

    for (const [i, k] of commissions.entries()) {
      log(`(${i + 1}/${commissions.length}) ${THEMES[k.theme].name} ${k.province.city}`);
      const plans = THEMES[k.theme].meetings;
      await archivalMeeting(k, plans[0], 1, 210, [100, 100]);
      await archivalMeeting(k, plans[1], 2, 150, [100, 70, 40]);
      await archivalMeeting(k, plans[2], 3, 75, [30, 0, 60]);
      await liveMeeting(k, plans[3], 4);
      await upcomingMeeting(k, plans[4], 7 + (i % 10));
      await api(k.members[3], 'POST', `/commissions/${k.id}/issues`, { title: THEMES[k.theme].issue, description: `گزارش اعضا در ${k.province.city}` }).catch(() => undefined);
    }
    log('شبکه‌ها، انتشار مصوبات، حمایت‌ها و پیشنهادهای ملی…');
    await buildNetworks(root, coordinator, commissions);
    log('اطلاعات ارائه کامل شد.');
    return { commissions: commissions.length };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  showcase({ password: process.env.SHOWCASE_PASSWORD || undefined, rootPassword: process.env.ROOT_PASSWORD || undefined })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
