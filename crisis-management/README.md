# سامانه مدیریت بحران شهری

API، کنسول مدیریت و اپلیکیشن (وب‌اپ موبایل) با احراز هویت **شاهکار + OTP** و کنترل دسترسی مبتنی بر نقش.

- **کنسول** (`/console/`): نام کاربری + رمز + OTP پیامکی. تعریف کاربران با استعلام شاهکار، نقش‌ها و ماتریس دسترسی، استعلام و سوابق شاهکار، لاگ ممیزی، مدیریت حوادث و مأموریت‌ها.
- **اپ** (`/app/`): ورود اولیه با استعلام شاهکار (کد ملی ↔ موبایل) و سپس OTP؛ ورودهای بعدی از همان دستگاه (توکن دستگاه) فقط با OTP. مأموریت‌ها، گزارش حادثه، هشدارها.
- **انطباق با پروفایل حفاظتی افتا** (برنامه‌های کاربردی تحت شبکه، نسخه ۱.۱): ممیزی زنجیره‌ای غیرقابل تغییر، پایش صحت داده، تنظیمات امنیتی قابل مدیریت، قفل تدریجی، محدودیت و مقیدسازی نشست، محدودیت شبکه/زمان ورود، سوابق ورود، یک نقش برای هر کاربر، خروجی کنترل‌شده، TLS 1.2.

| سند | محتوا |
|---|---|
| [`docs/security-profile.md`](docs/security-profile.md) | پروفایل امنیتی، نقش‌ها و ماتریس دسترسی |
| [`docs/afta-pp-compliance.md`](docs/afta-pp-compliance.md) | انطباق بند به بند با پروفایل حفاظتی افتا «برنامه‌های کاربردی تحت شبکه» نسخه ۱.۱ (۶۲ الزام + پیوست‌ها) |
| [`docs/guide-operational.md`](docs/guide-operational.md) | راهنمای کاربری (AGD_OPE) |
| [`docs/guide-preparative.md`](docs/guide-preparative.md) | راهنمای آماده‌سازی و استقرار امن (AGD_PRE) |

## راه‌اندازی

پیش‌نیاز: Node.js 22 و PostgreSQL 16.

```bash
cd crisis-management
npm ci
cp .env.example .env        # مقداردهی و بارگذاری متغیرها
npm run build
npm run seed                # مناطق + اولین «مدیر امنیت» (پس از تطابق شاهکار؛ رمز موقت یک‌بار چاپ می‌شود)
npm start                   # migration خودکار و اجرا روی PORT
```

### محیط توسعه (بدون اتصال به api.ir)

```bash
createdb crisis
npm run seed -- --demo      # کاربران نمایشی برای همه نقش‌ها (رمز: Demo-Pass-1234!)
npm run dev                 # APIIR_MODE=mock: شاهکار شبیه‌سازی و کد OTP در لاگ سرور چاپ می‌شود
```

در حالت `mock` هر شماره‌ای که به `9999` ختم شود «عدم تطابق شاهکار» برمی‌گرداند.

### آزمون‌ها

```bash
TEST_DATABASE_URL=postgres://crisis:crisis@localhost:5432/crisis_test npm test
```

## اتصال به api.ir

| متغیر | توضیح |
|---|---|
| `APIIR_MODE` | `live` در عملیات (اجباری در production)، `mock` برای توسعه |
| `APIIR_TOKEN` | توکن Bearer پنل api.ir |
| `APIIR_SHAHKAR_ENDPOINT` | `ShahkarPro` (پیش‌فرض، مناسب سازمان‌ها) / `Shahkar` / `ShahkarLite` |
| `APIIR_OTP_TEMPLATE` | الگوی پیامک SmsOTP؛ ۱ = «کد ورود» |
| `SHAHKAR_REVERIFY_DAYS` | دوره استعلام مجدد شاهکار |
| `SHAHKAR_ON_NEW_DEVICE` | استعلام شاهکار در اولین ورود از دستگاه جدید |

## API

| مسیر | توضیح |
|---|---|
| `POST /api/app/auth/start` | `{nationalCode, mobile, deviceId, deviceToken?}` → شاهکار (در ورود اولیه / دستگاه بدون توکن معتبر) + ارسال OTP |
| `POST /api/app/auth/verify` | `{challengeId, code, deviceId, firstName?, lastName?}` → توکن‌ها + `deviceToken` + سوابق ورود |
| `POST /api/console/auth/login` | `{username, password}` → ارسال OTP |
| `POST /api/console/auth/verify` | `{challengeId, code}` → توکن‌ها |
| `POST /api/{console,app}/auth/refresh` · `logout` | چرخش توکن / خروج |
| `POST /api/console/auth/change-password` | تغییر رمز |
| `GET /api/console/auth/help` | راهنمای ورود (تنها اقدام پیش از احراز هویت) |
| `/api/console/users` | فهرست، تعریف (با شاهکار)، ویرایش، `/:id/role` (یک نقش)، `/:id/status`، `/:id/unlock`، `/:id/reset-password`، `/:id/shahkar`، `/:id/sessions` |
| `/api/console/roles` | نقش‌ها، کاتالوگ مجوزها، تعریف/ویرایش/حذف نقش سفارشی |
| `/api/console/security` | `shahkar/inquiry`، `shahkar/inquiries`، `audit` (فیلتر و مرتب‌سازی)، `audit/export`، `audit/archive`، `integrity/check`، `settings` و `settings/:key`، `notifications`، `districts` |
| `GET /api/console/export/incidents?format=csv\|json` | خروجی کنترل‌شده با فراداده امنیتی |
| `GET /api/public/alerts` | هشدارهای عمومی بدون احراز هویت |
| `/api/{console,app}/incidents`، `tasks`، `alerts`، `responders`، `reports/summary` | عملیات (فیلترشده بر اساس دامنه نقش) |
| `/api/{console,app}/me` | پروفایل، نقش‌ها، مجوزها و نشست‌های کاربر |
