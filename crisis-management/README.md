# سامانه مدیریت بحران شهری

API، کنسول مدیریت و اپلیکیشن (وب‌اپ موبایل) با احراز هویت **شاهکار + OTP** و کنترل دسترسی مبتنی بر نقش.

- **کنسول** (`/console/`): نام کاربری + رمز + OTP پیامکی. تعریف کاربران با استعلام شاهکار، نقش‌ها و ماتریس دسترسی، استعلام و سوابق شاهکار، لاگ ممیزی، مدیریت حوادث و مأموریت‌ها.
- **اپ** (`/app/`): ورود اولیه با استعلام شاهکار (کد ملی ↔ موبایل) و سپس OTP؛ ورودهای بعدی فقط با OTP. مأموریت‌ها، گزارش حادثه، هشدارها.

پروفایل امنیتی کامل، فهرست نقش‌ها و ماتریس دسترسی: [`docs/security-profile.md`](docs/security-profile.md)

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
| `POST /api/app/auth/start` | `{nationalCode, mobile, deviceId}` → شاهکار (در ورود اولیه) + ارسال OTP |
| `POST /api/app/auth/verify` | `{challengeId, code, deviceId, firstName?, lastName?}` → توکن‌ها |
| `POST /api/console/auth/login` | `{username, password}` → ارسال OTP |
| `POST /api/console/auth/verify` | `{challengeId, code}` → توکن‌ها |
| `POST /api/{console,app}/auth/refresh` · `logout` | چرخش توکن / خروج |
| `POST /api/console/auth/change-password` | تغییر رمز |
| `/api/console/users` | فهرست، تعریف (با شاهکار)، ویرایش، `/:id/roles`، `/:id/status`، `/:id/unlock`، `/:id/reset-password`، `/:id/shahkar`، `/:id/sessions` |
| `/api/console/roles` | نقش‌ها، کاتالوگ مجوزها، تعریف/ویرایش/حذف نقش سفارشی |
| `/api/console/security` | `shahkar/inquiry`، `shahkar/inquiries`، `audit`، `settings`، `districts` |
| `/api/{console,app}/incidents`، `tasks`، `alerts`، `responders`، `reports/summary` | عملیات (فیلترشده بر اساس دامنه نقش) |
| `/api/{console,app}/me` | پروفایل، نقش‌ها، مجوزها و نشست‌های کاربر |
