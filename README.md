# پلتفرم ویزیت از راه دور با دستیار هوشمند — MVP

پیاده‌سازی قابل اجرای «سند طراحی فنی پلتفرم پزشکی از راه دور با دستیار هوشمند». دستیار هوشمند نقطه ورود بیمار است: به پرسش‌ها پاسخ می‌دهد، علائم را اولویت‌بندی می‌کند و نوبت می‌گیرد. تشخیص و صدور نسخه فقط با پزشک است.

## اجرا

نیازمندی: Node.js نسخه 22.13 یا بالاتر. هیچ وابستگی npm لازم نیست (پایگاه داده SQLite داخلی Node است).

```bash
npm start          # http://localhost:3000
npm test           # تست‌های یکپارچه و قواعد دستیار
docker build -t telehealth . && docker run -p 3000:3000 -e MASTER_SECRET=... telehealth
```

در حالت توسعه، کد OTP در صفحه ورود نمایش داده می‌شود و پیامک‌ها در بخش «پیام‌ها» دیده می‌شوند.

| نقش | شماره |
|---|---|
| بیمار | هر شماره موبایل جدید، مثلاً `09351234567` |
| پزشک عمومی / قلب / پوست / کودکان / روان / گوارش / گوش‌وحلق / اعصاب | `09120000001` تا `09120000008` (با تأیید دومرحله‌ای) |
| اپراتور | `09120000009` |
| مدیر | `09120000010` |

تنظیمات در `.env.example` آمده است.

## نصب روی سرور (VPS)

روی یک سرور لینوکسی تازه، با کاربر root، این یک فرمان را اجرا کنید:

```bash
curl -fsSL https://raw.githubusercontent.com/ardeshirazimi2000-design/kx21/claude/telehealth-mvp/deploy/install.sh | bash
```

اسکریپت `deploy/install.sh` این کارها را انجام می‌دهد:
- نصب Node.js 22 و git
- دریافت کد در `/opt/kx21`
- ساخت سرویس systemd به نام `kx21`، که با ری‌استارت سرور خودکار بالا می‌آید
- ساخت کلید محرمانه در `/etc/kx21.env`
- نگهداری داده در `/var/lib/kx21`
- باز کردن پورت 3000 در فایروال

اجرای دوباره همین فرمان کد را به‌روز می‌کند و داده‌ها حفظ می‌شوند.

**دامنه و HTTPS:** پس از ثبت دامنه و تنظیم رکورد A آن روی IP سرور، اجرا کنید:

```bash
curl -fsSL .../deploy/install.sh | DOMAIN=clinic.example.ir EMAIL=you@example.ir bash
```

این دستور Caddy را نصب می‌کند و گواهی HTTPS را خودکار می‌گیرد.

> این نصب **آزمایشی** است: چون هنوز سرویس پیامک وصل نشده، کد ورود روی صفحه نمایش داده می‌شود و حساب‌های نمونهٔ پزشک فعال‌اند. تا اتصال سرویس پیامک و تغییر به حالت production، اطلاعات بیمار واقعی وارد نکنید.

## اپ موبایل

دو راه برای نصب روی گوشی وجود دارد. هر دو از همان رابط کاربری `public/` استفاده می‌کنند.

### ۱. اپ اندروید (APK)

پروژهٔ اندروید در `mobile/` با Capacitor ساخته شده است. نام اپ «کلینیک آنلاین» و شناسه‌اش `ir.kx21.clinic` است.

```bash
cd mobile
npm install
API_URL=https://clinic.example.ir npm run build:www   # آدرس سرور داخل اپ ثابت می‌شود (اختیاری)
npx cap sync android
cd android && ./gradlew assembleDebug                 # خروجی: app/build/outputs/apk/debug/app-debug.apk
```

- **ابزار لازم:** JDK 21 و Android SDK (platform 36). مسیر SDK در `ANDROID_HOME` یا `android/local.properties` قرار می‌گیرد.
- **آدرس سرور:** اگر `API_URL` داده نشود، اپ در اولین اجرا آدرس سرور را می‌پرسد. این آدرس بعداً از صفحهٔ ورود هم قابل تغییر است.
- **HTTP و HTTPS:** نسخهٔ debug برای آزمایش روی شبکهٔ محلی به سرور `http://` هم وصل می‌شود، مثلاً `http://192.168.1.10:3000`. نسخهٔ release فقط با HTTPS کار می‌کند.
- **انتشار در فروشگاه:** برای بازار، مایکت یا Google Play نسخهٔ release لازم است:
  1. یک keystore بسازید و آن را امن نگه دارید.
  2. فایل `android/keystore.properties` را با کلیدهای `storeFile`، `storePassword`، `keyAlias` و `keyPassword` بسازید.
  3. دستور `./gradlew assembleRelease` یا `bundleRelease` را اجرا کنید.

  هیچ‌کدام از این دو فایل نباید commit شود.
- **حفاظت از داده:** پشتیبان‌گیری ابری و انتقال دادهٔ اپ بین دستگاه‌ها غیرفعال است تا داده و توکن ورود از گوشی خارج نشود.
- **آیکون‌ها:** با `npm run icons` از روی رنگ و طرح برند دوباره ساخته می‌شوند.
- **سرور:** باید مبدأ اپ را مجاز کند. مقدار پیش‌فرض `CORS_ORIGINS` شامل `https://localhost` (اندروید) و `capacitor://localhost` (iOS) است.

### ۲. نصب از مرورگر (PWA) — اندروید و iPhone

وقتی سرور روی HTTPS منتشر شود، کاربر سایت را در مرورگر گوشی باز می‌کند و آن را نصب می‌کند:
- **Chrome اندروید:** دکمهٔ «📲 نصب اپ روی گوشی» یا گزینهٔ «Add to Home screen».
- **Safari آیفون:** گزینهٔ «Add to Home Screen».

PWA شامل manifest و service worker است که پوستهٔ اپ را برای باز شدن سریع cache می‌کند. دادهٔ سلامت هیچ‌وقت cache نمی‌شود. ساخت اپ بومی iOS به macOS و Xcode نیاز دارد (`npx cap add ios`).

## نگاشت به سند طراحی

| بخش سند | پیاده‌سازی |
|---|---|
| ۱. پنج سرویس در MVP | `src/modules/`: Auth، Patient (+ماژول Doctor)، Appointment (+ماژول Notification)، Consultation (+Prescription)، AI Assistant (+Triage). هر ماژول مالک جداول خودش است و از طریق رویداد با بقیه صحبت می‌کند، پس بعداً قابل جداسازی است. |
| ۳. رویدادها | `user.registered`، `consent.accepted`، `slot.published`، `appointment.booked/cancelled`، `consultation.started/ended`، `triage.completed`، `prescription.issued`، `ai.escalated`. همه در جدول outbox ثبت می‌شوند (جایگزین Kafka). |
| ۴. دستیار پنج‌حالته | `src/modules/ai/assistant.js`: حالت‌های INFO، TRIAGE، BOOKING، EMERGENCY و FOLLOWUP. هر tool فقط در حالت مجاز خود اجرا می‌شود. `book_appointment` فقط پس از تأیید صریح بیمار و با Idempotency-Key ساخته‌شده از session و slot اجرا می‌شود. `fetch_patient_history` فقط با رضایت `ai_history_access` کار می‌کند. |
| ۴.۳ جریان پیام | rate limit ← input guardrail ← قاعده ثابت اورژانس (پیش از هر مدل) ← intent ← retrieval ← تصمیم ← output guardrail ← audit با trace_id ← SSE |
| ۴.۵ قواعد ایمنی | خروجی‌های حاوی تشخیص یا دوز مسدود و به پزشک ارجاع می‌شوند. پاسخ اورژانس از قالب ثابت می‌آید و شامل ۱۱۵ است. خروج از حالت اورژانس فقط با اپراتور ممکن است. پاسخ با اطمینان پایین retrieval به اپراتور ارجاع می‌شود، نه حدس. |
| ۴.۶ ارزیابی | `test/ai-rules.test.js`: بخشی از golden dataset برای recall اورژانس، سطوح triage، guardrail، intent و retrieval. |
| ۵. مدل داده | `src/lib/db.js`: همه جداول `tenant_id` دارند و حذف نرم است. national_id با envelope encryption (AES-256-GCM) رمز می‌شود و برای جستجو HMAC دارد. یک partial unique index مانع رزرو دوباره یک slot است. audit_logs با trigger فقط قابل افزودن است. triage_results نسخه قواعد را نگه می‌دارد. |
| ۶. API | REST نسخه‌دار (`/v1`)، خطای استاندارد `{code, message, trace_id}`، Idempotency-Key اجباری برای رزرو و نسخه، cursor pagination، rate limit به ازای IP، کاربر و tenant، و SSE برای `/v1/ai/chat` با رویدادهای token، tool_call، mode_change، citation، escalation و done. |
| ۷. گفتگو تا رزرو | پاسخ 409 (slot گرفته‌شده) باعث می‌شود دستیار دوباره `check_availability` را اجرا کند و گزینه جدید بدهد. |
| ۸. امنیت | OTP برای بیمار؛ MFA اجباری برای پزشک، اپراتور و مدیر؛ RBAC به‌همراه ABAC (پزشک فقط با رابطه نوبت به پرونده دسترسی دارد)؛ ماسک داده حساس در لاگ؛ امضای Ed25519 روی نسخه با endpoint عمومی بررسی اعتبار؛ خروجی و حذف داده به سبک GDPR. |

## جایگزین‌های محلی (بدون زیرساخت خارجی)

این موارد عمداً ساده شده‌اند تا برنامه بدون GPU و سرویس بیرونی اجرا شود. رابط هر کدام با سند یکی است:

- **LLM:** با تنظیم `LLM_BASE_URL` به vLLM یا هر endpoint سازگار با OpenAI وصل می‌شود. بدون آن، پاسخ از متن knowledge base ساخته می‌شود. انتخاب tool در این نسخه با قواعد قطعی انجام می‌شود، نه با LLM.
- **Intent و RAG:** به‌جای مدل classifier و pgvector، از قواعد کلیدواژه‌ای فارسی و BM25 استفاده شده است. متن knowledge base نمونه است و **باید توسط مشاور بالینی تأیید شود**.
- **ویدیو:** توکن اتاق در قالب LiveKit صادر می‌شود، ولی بدون `LIVEKIT_URL` ویزیت به‌صورت چت متنی انجام می‌شود (همان مسیر fallback سند).
- **Keycloak، Kafka، Redis، PostgreSQL، SMS:** به‌ترتیب با JWT داخلی، outbox و EventEmitter، جدول نشست، SQLite و صندوق اعلان درون‌برنامه جایگزین شده‌اند.
- **پرداخت، STT صوتی و EHR Bridge:** طبق نقشه راه سند در فازهای بعد هستند. پیام صوتی و تصویری فعلاً خطای 422 می‌گیرد.

## ساختار

```
src/
  app.js              composition root + API gateway (rate limit, tenant, trace id, security headers)
  lib/                http, crypto (JWT/envelope/Ed25519), db schema, events+audit, Persian text
  modules/auth.js     OTP, JWT, MFA
  modules/patient.js  profile, consents, GDPR, doctors, ABAC
  modules/appointment.js  slots, idempotent booking, cancel/reschedule, notifications
  modules/consultation.js visit room, chat, end, prescriptions
  modules/ai/         assistant state machine, triage rules, guardrails, intent, KB/RAG, LLM, routes
public/               RTL web client (patient, doctor, operator, admin) + PWA manifest/service worker
mobile/               Capacitor Android app wrapping public/
test/                 node:test suites
```
