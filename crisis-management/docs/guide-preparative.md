# راهنمای آماده‌سازی و استقرار امن (AGD_PRE) — سامانه مدیریت بحران شهری

## ۱. پیش‌نیازهای محیط عملیاتی
- سرور لینوکس به‌روز با NTP فعال (مهر زمانی معتبر، FPT_STM)، Node.js 22، PostgreSQL 16 (ترجیحاً روی سرور جدا).
- فایروال: فقط پورت HTTPS سامانه در دسترس کاربران باشد. پورت پایگاه داده فقط از سرور برنامه باز باشد.
- حفاظت در برابر DoS/DDoS در لبه شبکه (فرض پروفایل).
- پشتیبان‌گیری منظم از پایگاه داده و فایل‌های پیکربندی، و نگهداری امن خروجی‌های ممیزی.
- حساب api.ir با دسترسی به سرویس‌های ShahkarPro، SmsOTP و SendSms.

## ۲. نصب و تأیید بسته (FPT_TUD_EXT)
```bash
scripts/verify-release.sh crisis-management-<نسخه>.tgz SHA256SUMS SHA256SUMS.sig publisher-public.pem
tar xzf crisis-management-<نسخه>.tgz && cd crisis-management
npm ci --omit=dev        # وابستگی‌ها با چکیده‌های package-lock.json تأیید می‌شوند
npm run build
```
اگر امضا یا چکیده تأیید نشود، بسته را نصب نکنید.

**امضای بسته (سمت ناشر):**
- کلید امضا: RSA ≥ 2048 یا ECDSA P-256.
- نمونه تولید کلید: `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out publisher-private.pem`

## ۳. پیکربندی امن (`.env`)

### متغیرهای الزامی

| متغیر | الزام |
|---|---|
| `NODE_ENV=production` | سامانه در این حالت بدون اسرار واقعی، `APIIR_MODE=live` و `REQUIRE_HTTPS=true` اجرا نمی‌شود. |
| `JWT_SECRET`، `OTP_PEPPER`، `AUDIT_KEY`، `INTEGRITY_KEY` | چهار کلید تصادفی مستقل، هر کدام ≥ ۳۲ بایت. نمونه تولید: `openssl rand -base64 48` |
| `APIIR_MODE=live`، `APIIR_TOKEN` | توکن پنل api.ir |
| `DATABASE_URL` | نقش اجرایی محدود (فقط SELECT/INSERT/UPDATE/DELETE؛ **نه مالک جداول، نه superuser**) — بند ۵ |
| `MIGRATE_ON_START=false` | مهاجرت با نقش مالک و جداگانه: `DATABASE_URL=<مالک> npm run migrate` |
| `DATABASE_SSL=verify-full`، `DATABASE_SSL_CA_FILE` | وقتی پایگاه داده روی سرور جداست (FPT_ITT) |
| `REQUIRE_HTTPS=true`، `TRUST_PROXY=true` | پشت پراکسی TLS |
| `AUDIT_FALLBACK_FILE` | مسیری با دسترسی فقط برای کاربر سرویس، برای زمان قطع پایگاه داده |
| `TIME_ZONE=Asia/Tehran` | برای قواعد روز و ساعت ورود |

**نگهداری کلیدها:** فایل `.env` با مجوز `600` و مالکیت کاربر سرویس نگهداری شود.

**چرخش و تخریب کلیدها (FCS_CKM.4):**
- کلید جدید را جایگزین کنید و نسخه‌های قدیمی را از همه محل‌ها، از جمله پشتیبان‌های پیکربندی، به‌صورت امن پاک کنید (`shred`).
- تغییر `AUDIT_KEY` یا `INTEGRITY_KEY` بررسی صحت رکوردهای قبلی را ناممکن می‌کند. پیش از تغییر، از ممیزی خروجی بگیرید و بایگانی کنید، و رکوردهای حوادث را با کلید جدید مهر کنید.

### TLS (FTP_TRP، FCS_TLSS_EXT)

**گزینه الف — TLS داخلی برنامه:**
- `TLS_CERT_FILE` و `TLS_KEY_FILE` را تنظیم کنید.
- گواهی X.509v3 از CA مورد اعتماد، با کلید RSA ≥ 2048 یا ECDSA P-256/P-384.
- سامانه فقط TLS 1.2 را با مجموعه رمزهای ECDHE AES-GCM/CBC پروفایل می‌پذیرد.

**گزینه ب — پراکسی معکوس (nginx/HAProxy):**
- فقط `TLSv1.2`، با همان مجموعه رمزها:
  `ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-SHA256:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384`
- منحنی‌ها: `P-256:P-384`.
- `TRUST_PROXY=true` و انتقال سرآیند `X-Forwarded-Proto`.

**گواهی کاربر برای کنسول (اختیاری، mTLS):**
- `TLS_CLIENT_CA_FILE` و `TLS_CLIENT_CRL_FILE` را تنظیم کنید و `TLS_REQUIRE_CLIENT_CERT_CONSOLE=true` قرار دهید.
- فهرست ابطال (CRL) را به‌طور دوره‌ای به‌روز کنید و سرویس را دوباره بارگذاری کنید.

## ۴. راه‌اندازی اولیه
```bash
export BOOTSTRAP_ADMIN_NATIONAL_CODE=... BOOTSTRAP_ADMIN_MOBILE=... BOOTSTRAP_ADMIN_USERNAME=secadmin
npm run seed     # مهاجرت پایگاه داده + مناطق + اولین «مدیر امنیت» پس از تطابق شاهکار
npm start
```
- رمز موقت مدیر فقط یک‌بار چاپ می‌شود و در اولین ورود باید تغییر کند.
- **حساب پیش‌فرض یا رمز ثابت وجود ندارد.**
- گزینه `--demo` (کاربران نمایشی) فقط با شبیه‌ساز کار می‌کند و در production رد می‌شود.

پس از اولین ورود:
1. مدیر امنیت، اولین «ممیز امنیتی» را تعریف کند. ممیز جداگانه وارد شود و تنظیمات ممیزی را بازبینی کند.
2. مدیر امنیت تنظیمات امنیتی را مطابق خط‌مشی سازمان مقداردهی کند:
   - شبکه‌های مجاز کنسول؛
   - ساعت و روزهای کاری؛
   - آستانه قفل؛
   - طول و عمر رمز؛
   - سقف نشست‌ها.
3. تعریف سایر کاربران و تخصیص نقش.

## ۵. سخت‌سازی و نگهداری
- سرویس با کاربر غیر root و `NODE_ENV=production` اجرا شود، زیر مدیر سرویس (systemd) با راه‌اندازی مجدد خودکار (FRU_FLT).
- نقش اجرایی برنامه نباید مالک جداول یا superuser باشد تا نتواند تریگرهای `audit_log` را غیرفعال کند. هر دستکاری مستقیم در پایگاه داده نیز با زنجیره HMAC تشخیص داده می‌شود. نمونه:
  ```sql
  CREATE ROLE crisis_app LOGIN PASSWORD '...';
  GRANT USAGE ON SCHEMA public TO crisis_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crisis_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crisis_app;
  REVOKE UPDATE ON audit_log FROM crisis_app;   -- DELETE فقط برای بایگانی لازم است و تریگر در غیر آن رد می‌کند
  ```
- ممیزی پایگاه داده و سیستم‌عامل در محیط فعال باشد (هدف «ممیزی کامل» محیط).
- لاگ‌های برنامه (pino، بدون رمز، OTP یا توکن) به SIEM سازمان ارسال شود.
- سرویس‌ها و پورت‌های استفاده‌نشده غیرفعال باشند و صفحه‌های پیش‌فرض وب‌سرور حذف شوند.
- **به‌روزرسانی:** فقط دستی و پس از اجرای `scripts/verify-release.sh`. نسخه فعلی در «تنظیمات امنیتی» کنسول نمایش داده می‌شود (فقط برای مدیران).
- **آزمون پذیرش پس از استقرار:**
  - `npm test` روی پایگاه داده آزمایشی؛
  - بررسی رد شدن TLS 1.0/1.1 با `openssl s_client -tls1_1`؛
  - بررسی صحت ممیزی از کنسول ممیز.
