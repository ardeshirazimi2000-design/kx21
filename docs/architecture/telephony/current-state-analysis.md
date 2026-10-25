# تحلیل وضعیت فعلی مخزن برای یکپارچه‌سازی Issabel

> وضعیت: پیش‌نویس طراحی، بدون تغییر در کد. مبنای بررسی: شاخه `claude/commission-platform` (کامیت `83bab32`) در تاریخ ۲۰۲۶-۱۰-۲۵.
>
> قرارداد این سند: «**قطعی**» یعنی در کد دیده شده و مسیر آن آمده است. «**نامشخص**» یعنی نه در کد و نه در مستندات اثبات نشده است. وجود یک قابلیت در مستندات `docs/office/` به‌تنهایی دلیل پیاده‌سازی آن تلقی نشده و هر ادعا با کد تطبیق داده شده است.

## ۰. خلاصه

| موضوع | وضعیت |
|---|---|
| هر نوع کد، جدول، تنظیم یا مستند درباره Issabel، Asterisk، AMI، ARI، SIP، CDR یا داخلی تلفن | **قطعی: وجود ندارد.** جستجوی `issabel|asterisk|AMI|voip|sip|telephon|تلفن` در کد و مستندات فقط به متن پاورقی سربرگ نامه («نشانی و تلفن») رسید. |
| نسخه Issabel، نسخه Asterisk، درایور کانال (chan_sip یا PJSIP)، وجود REST API مدیریتی | **نامشخص.** در مخزن هیچ اطلاعاتی درباره مرکز تلفن نیست؛ باید از مدیر مرکز تلفن گرفته شود (`open-questions.md`). |
| زیرساخت قابل استفاده دوباره: صف پایدار، صندوق رویداد با حذف تکرار، رمزنگاری اسرار، ممیزی زنجیره‌ای، RBAC با دامنه واحد، اعلان | **قطعی: موجود است** و برای ماژول تلفن کافی است؛ نیاز به زیرساخت موازی (Redis، Kafka، سرویس جدا) نیست. |
| دفترچه مخاطبان (اشخاص بیرونی با شماره تلفن) | **قطعی: وجود ندارد.** |
| به‌روزرسانی لحظه‌ای در رابط کاربری (WebSocket یا SSE) | **قطعی: وجود ندارد.** فقط Polling هر ۶۰ ثانیه. |
| سازوکار عمومی «تأیید تغییر» (Maker-Checker) خارج از نامه‌ها | **قطعی: وجود ندارد.** موتور گردش کار به نامه گره خورده است. |

## ۱. ساختار پروژه و سرویس‌ها

- مونوریپوی npm با workspaceها: `apps/api` (سامانه جلسات)، `apps/web`، `apps/mobile`، `apps/office-api`، `apps/office-web`، `packages/` (از جمله `@kx/shared` برای تاریخ شمسی).
- **office-api**: Express 5 + TypeScript + PostgreSQL (`pg`)، اعتبارسنجی `zod`، لاگ `pino`. وابستگی‌ها در `apps/office-api/package.json`؛ هیچ کتابخانه AMI/SIP/WebSocket وجود ندارد.
  - نقطه ورود: `apps/office-api/src/server.ts` (اجرای مهاجرت، `ensureBaseData`، `startWorker`، `startScheduler`). ماژول یکپارچه‌سازی با `import './integration/meetings.js'` فقط برای ثبت هندلرهای صف بارگذاری می‌شود؛ الگوی مناسب برای ماژول تلفن.
  - برنامه: `apps/office-api/src/app.ts` تابع `createApp`؛ مسیرهای عمومی (`integrationPublicRouter`، `/api/auth`، `publicLettersRouter`) و مسیرهای محافظت‌شده زیر `authenticate` و محدودیت نرخ ۶۰۰ درخواست در دقیقه به‌ازای کاربر.
  - مهاجرت‌ها: فایل‌های SQL ترتیبی در `apps/office-api/src/db/migrations/` (`001_init.sql` تا `004_smart_search.sql`) با جدول `schema_migrations` در `db/migrate.ts`؛ هر فایل در یک تراکنش.
  - پیکربندی: `apps/office-api/src/config.ts` فقط از متغیرهای محیطی؛ `DATA_ENCRYPTION_KEY` در تولید الزامی است.
  - استقرار: `docker-compose.yml` سرویس‌های `office-db`، `office-api`، `office-web`؛ مسیر شبکه‌ای از کانتینر به مرکز تلفن **نامشخص** است.
- **office-web**: React 19 + react-router 7 + Vite؛ بدون کتابخانه مدیریت وضعیت یا WebSocket. مسیرها در `apps/office-web/src/App.tsx`.
- **وضعیت PRهای ۴ تا ۶**: در GitHub بسته شده‌اند و زمان ادغام دارند؛ محتوای هر سه (مهاجرت‌های `002_invitations_signatures.sql`، `003_letter_templates.sql`، `004_smart_search.sql` و فایل‌های `routes/signatures.ts`، `routes/templates.ts`، `routes/search.ts`، `services/ai.ts`) در شاخه پایه موجود است. **قطعی.**

## ۲. کاربران، واحدها، سمت‌ها، نقش‌ها و مجوزها

| جدول/کد | یافته |
|---|---|
| `org_units` (`001_init.sql` خط ۱۰) | درخت واحد با `parent_id`، `code` یکتا، `kind`، `is_active`. |
| `positions` (خط ۲۰) | سمت در واحد، `parent_id` برای سلسله‌مراتب، `is_manager`. |
| `users` (خط ۳۰) | `username`، `full_name`، `national_id`، `email`، **`mobile`** (تنها فیلد تلفن)، `clearance` ۰ تا ۲ برای ABAC، MFA، کلید امضا. **هیچ فیلد داخلی، تلفن ثابت یا شماره کاری ندارد.** |
| `user_positions` (خط ۵۲) | انتساب کاربر به سمت با `is_primary`، `start_date`، `end_date`؛ تاریخچه سمت به این شکل نگه داشته می‌شود. الگوی مناسب برای تاریخچه تخصیص داخلی. |
| `roles`، `permissions`، `role_permissions`، `user_roles` (خط ۶۲ تا ۹۰) | RBAC؛ `user_roles.scope_unit_id` نقش را به یک زیردرخت واحد محدود می‌کند. |
| `user_external_links` (خط ۱۰۴) | نگاشت کاربر به شناسه سامانه دیگر (`system`، `external_id`، `matched_by`). تابع `mapExternalUser` در `integration/meetings.ts` از آن استفاده می‌کند. قابل استفاده برای نگاشت شناسه کاربر در Issabel (در صورت وجود)، ولی **برای داخلی کافی نیست** چون تاریخچه و قید یکتایی فعال/غیرفعال ندارد. |
| `services/permissions.ts` | کاتالوگ ثابت `PERMISSIONS` (۲۴ کلید) و `SYSTEM_ROLES` (admin، secretariat، manager، president، expert، it). در `db/bootstrap.ts` تابع `ensureBaseData` هنگام شروع کاتالوگ را upsert می‌کند؛ پس افزودن مجوز جدید با افزودن به آرایه و (برای نقش‌های موجود) یک مهاجرت `INSERT ... role_permissions` انجام می‌شود، همان کاری که `002` و `003` کرده‌اند. |
| `auth/middleware.ts` | `loadAuthUser` مجوزها را به `'all'` یا مجموعه واحدها (با زیرشاخه‌ها) تبدیل می‌کند؛ `can(p, unitId)`، `unitsFor(p)` و `requirePerm`. `managedUnits` برای مدیران واحد. |
| `services/access.ts` | ABAC نامه (`letterVisibleSql`) و سند بایگانی (`documentVisibleSql`)؛ نامه نامرئی ۴۰۴ برمی‌گرداند. هر اتصال تماس به نامه یا سند باید از همین توابع عبور کند. |

## ۳. مسیرهای API، احراز هویت، RBAC/ABAC و ممیزی

- احراز هویت: JWT دسترسی ۱۵ دقیقه‌ای و توکن تمدید چرخشی (`auth/tokens.ts`، `routes/auth.ts`)، TOTP (`auth/totp.ts`)، الزام MFA برای نقش‌های `MFA_REQUIRED_ROLES`.
- الگوی مسیر: هر مسیر با `requirePerm(currentUser(req), '<perm>')` شروع می‌شود و تغییرات داخل `tx(async (c) => ...)` همراه `audit(c, req, {...})` انجام می‌شوند (مثلاً `routes/org.ts` خطوط ۳۷ تا ۱۰۶).
- خطاها: `lib/errors.ts` (`HttpError`، `badRequest`، `forbidden`، `notFound`، `unauthorized`) و قالب پاسخ `{ error: { code, message, details } }` در `app.ts`؛ کد `23505` به ۴۰۹ `duplicate` نگاشت می‌شود.
- ممیزی: `lib/audit.ts` تابع `audit` رکورد زنجیره‌هش در `audit_logs` (خط ۴۷۹) می‌نویسد؛ تریگر `audit_logs_no_update` از تغییر و حذف جلوگیری می‌کند؛ `verifyAuditChain` و مسیر `GET /api/audit/verify`.
  - **محدودیت مهم:** هر فراخوانی `audit` قفل سراسری `pg_advisory_xact_lock(hashtext('audit'))` می‌گیرد. ثبت هر رویداد تماس در ممیزی گلوگاه می‌شود؛ رویدادهای پرحجم تماس نباید به `audit_logs` بروند.
- مستند API: `apps/office-api/openapi.yaml` (تولید با `scripts/gen-openapi.py`).

## ۴. یکپارچه‌سازی، صف و پردازش رویداد

| جزء | یافته |
|---|---|
| `integrations` (خط ۳۸۵) | یک ردیف برای هر `kind` (قید `UNIQUE`)، `base_url`، `client_id`، `client_secret_enc`، `webhook_secret_enc`، `inbound_key_hash`، `settings`، `state`، `last_sync_at`، `last_error`. قید `integrations_kind_check` در `004_smart_search.sql` خط ۲۴ فعلاً `meetings, accounting, crm, government, intake, ai` است؛ **افزودن `telephony` مهاجرت لازم دارد.** فقط **یک** راز رمزشده برای خروجی دارد؛ تلفن به چند راز (AMI، API مدیریتی، پایگاه CDR) نیاز دارد. |
| `integration_inbox` (خط ۴۰۳) | رویداد ورودی با `UNIQUE (system, event_id)` برای حذف تکرار، وضعیت `received/processed/failed/ignored`. تابع `receiveEvent` در `integration/meetings.ts` خط ۱۱۲ با `ON CONFLICT DO NOTHING` و سپس `enqueue`. |
| `jobs` (خط ۳۶۹) و `services/jobs.ts` | صف پایدار PostgreSQL با `FOR UPDATE SKIP LOCKED`، `registerHandler`، `enqueue` درون تراکنش تولیدکننده، تلاش مجدد نمایی تا ۱ ساعت و `max_attempts` پیش‌فرض ۸، بازگرداندن کارهای گیرکرده پس از ۱۰ دقیقه. |
| `services/scheduler.ts` | زمان‌بند دوره‌ای (پیش‌فرض ۳۰۰ ثانیه، `SCHEDULER_ENABLED=false` روی نمونه‌های دیگر). الگوی Polling رویدادهای سامانه جلسات با مکان‌نما در `integrations.state`. |
| `lib/crypto.ts` | `encryptText`/`decryptText` با AES-256-GCM و کلید `DATA_ENCRYPTION_KEY`. |
| صفحه مدیریت | `routes/integration.ts` (`GET /integrations` اسرار را حذف و فقط `hasApiKey` برمی‌گرداند؛ `PUT /integrations/meetings` با مجوز `integration.manage` و ممیزی)، `apps/office-web/src/pages/Integrations.tsx`. |
| **فقدان** | هیچ اتصال TCP ماندگار (مثل AMI) در کد نیست؛ همه یکپارچگی‌ها HTTP درخواست/پاسخ یا Webhook هستند. هیچ فرایند شنونده طولانی‌مدت جدا از Worker و Scheduler وجود ندارد. |

## ۵. نامه‌ها، اسناد، پرونده‌ها، مخاطبان و شماره تلفن

- `letters` (خط ۱۲۱): طرف بیرونی فقط متن آزاد است: `external_party`، `external_org`، `external_number` (شماره نامه، نه تلفن). **شماره تلفن طرف نامه ذخیره نمی‌شود.**
- «پرونده» در این سامانه به دو معنا وجود دارد: `archive_folders` (خط ۲۷۹، پوشه درختی بایگانی با واحد و سیاست نگهداری) و `documents` (خط ۲۹۱، سند با طبقه‌بندی، ارتباط اختیاری یکتا با نامه). معادل «پرونده موضوعی/Case» جدا **وجود ندارد.**
- ارتباطات موجود: `letter_meeting_refs`، `resolutions_cache.letter_id`، `meeting_invitation_letters`؛ الگوی جدول ارتباطی جدا برای هر نوع رابطه.
- **مخاطبان:** جدول یا API مخاطب (شخص یا سازمان بیرونی با شماره تماس) **وجود ندارد.** در سامانه جلسات (`apps/api/src/db/migrations/001_init.sql`) فقط `chambers.phone` و `mobile` اشخاص هست که به اتوماسیون منتقل نمی‌شود جز در `meetings_cache.data`.
- نتیجه: «اتصال تماس به مخاطب» بدون ایجاد دفترچه مخاطب ممکن نیست؛ تصمیم آن در `open-questions.md` آمده است.

## ۶. رابط کاربری، اعلان و به‌روزرسانی لحظه‌ای

- اعلان: `services/notifications.ts` تابع `notify` (درون‌برنامه فوری؛ ایمیل و پیامک از صف)، رویدادها در `NOTIFICATION_EVENTS` با قالب قابل ویرایش.
- لحظه‌ای: `apps/office-web/src/lib/hooks.ts` تابع `usePoll` و در `App.tsx` خطوط ۹۷ و ۹۸ شمارنده اعلان و کارتابل هر ۶۰ ثانیه. **هیچ SSE یا WebSocket وجود ندارد.** برای «وضعیت لحظه‌ای تماس» باید کانال جدیدی (پیشنهاد: SSE) اضافه شود.
- اجزای UI مشترک در `components/ui.tsx` (Card، Badge، Pager، Field، ...) و انتخابگرها در `components/pickers.tsx` (مثل `UnitSelect`).
- منوی کناری گروه‌بندی‌شده (`App.tsx`) با نمایش بر اساس مجوز.

## ۷. مستندات موجود درباره Issabel و Asterisk

- `docs/` و `docs/office/` (`01-architecture.md` تا `04-operations.md`): **هیچ اشاره‌ای به مرکز تلفن ندارند.**
- نسخه Issabel، نسخه Asterisk، فعال بودن AMI یا ARI، محل ذخیره CDR و CEL، وجود API مدیریتی (مثلاً بسته `pbxapi` در Issabel ۴)، درایور کانال و dialplan: **همه نامشخص.**
- دانش عمومی (نه یافته مخزن) که باید روی نسخه نصب‌شده تأیید شود:
  - Issabel از Elastix و IssabelPBX (انشعاب FreePBX) مشتق شده و پیکربندی داخلی‌ها را در پایگاه MySQL خود نگه می‌دارد و با «Apply Config» به فایل‌های Asterisk تبدیل می‌کند. پس **AMI رابط مدیریت پیکربندی داخلی‌ها نیست**؛ تغییر از AMI در رابط وب Issabel دیده نمی‌شود و با Apply بعدی بازنویسی می‌شود.
  - برخی نسخه‌های Issabel ۴ یک REST API مدیریتی (`/pbxapi`) دارند. وجود، نسخه و پوشش آن روی سرور واقعی **نامشخص** است و پایه فاز تغییر داخلی‌ها است.
  - CDR معمولاً در MySQL (`asteriskcdrdb.cdr`) و CEL در صورت فعال بودن در جدول `cel` ذخیره می‌شود.

## ۸. شکاف‌ها

| # | شکاف | پیامد طراحی |
|---|---|---|
| G1 | هیچ مدل داخلی یا شماره کاری برای کاربر | جداول جدید `pbx_extensions` و `extension_assignments` |
| G2 | `integrations` فقط یک راز خروجی و یک ردیف برای هر نوع دارد | جدول `telephony_connections` برای اسرار جدا به‌ازای هر رابط |
| G3 | هیچ اتصال ماندگار یا شنونده رویداد | فرایند «شنونده تلفن» تک‌نمونه در همان کد office-api |
| G4 | ممیزی قفل سراسری دارد | رویدادهای تماس در جداول عملیاتی، فقط اقدامات انسانی و تغییرات مدیریتی در ممیزی |
| G5 | Maker-Checker عمومی وجود ندارد | جدول `extension_change_requests` با قید «درخواست‌دهنده ≠ تأییدکننده» |
| G6 | مخاطب و شماره تلفن بیرونی وجود ندارد | دفترچه مخاطب حداقلی (پیشنهادی، منوط به تصمیم) |
| G7 | لحظه‌ای فقط Polling | SSE در فاز تماس لحظه‌ای؛ تا آن زمان Polling |
| G8 | هیچ اطلاعاتی از Issabel | پرسش‌نامه مدیر مرکز تلفن پیش‌نیاز فاز ۱ |
| G9 | `user_external_links` تاریخچه ندارد | تاریخچه تخصیص داخلی جدا، به سبک `user_positions` |
