# امنیت، مجوزها، اسرار و ممیزی ماژول تلفن

## ۱. مدل تهدید (خلاصه)

| تهدید | پیامد | کنترل |
|---|---|---|
| دسترسی مستقیم به AMI از شبکه کاربران | کنترل کامل تماس‌ها، شنود فراداده، Originate دلخواه | AMI فقط از IP سرور اتوماسیون (`permit/deny` در `manager.conf` و فایروال PBX)؛ TLS یا شبکه مدیریتی جدا؛ مرورگر هرگز اطلاعات اتصال نمی‌بیند |
| سوءاستفاده از تماس با یک کلیک (Toll Fraud) | هزینه تماس بین‌المللی/ویژه | فقط از داخلی خود کاربر، دسته‌بندی شماره و سیاست شماره‌گیری بر اساس نقش و واحد، فهرست مسدود، سقف ساعتی و روزانه، ثبت نتیجه هر درخواست در `click_to_call_requests` و هشدار سوءاستفاده (بخش ۸)، Originate فقط در Context عادی تا Outbound Routes و محدودیت‌های Issabel اعمال شود |
| SSRF از طریق تنظیم میزبان اتصال | دسترسی سرور به سرویس‌های داخلی دیگر | `allowedHosts` و فقط مجوز `telephony.settings.manage`؛ ممیزی تغییر |
| نشت اسرار اتصال | تصاحب PBX | AES-256-GCM با `encryptText`، هرگز در پاسخ API، لاگ، ممیزی یا پیام خطا |
| تغییر داخلی بدون اختیار | قطع خدمات تلفن، شنود (مثلاً تغییر مسیر) | مجوز اختصاصی، Maker-Checker، تشخیص تعارض، ممیزی |
| نشت حریم خصوصی تاریخچه تماس | افشای ارتباطات افراد | دامنه دید (خود/واحد/همه)، پوشاندن شماره، طبقه‌بندی، نگهداری محدود |
| جعل رویداد تماس | تاریخچه نادرست | رویدادها فقط از اتصال AMI احراز هویت‌شده؛ هیچ Webhook عمومی بدون امضا |
| از کار افتادن PBX | اختلال اتوماسیون | جداسازی کامل؛ Timeout و مدار قطع (`target-architecture.md` بخش ۶) |

## ۲. مجوزها

افزوده به `PERMISSIONS` در `apps/office-api/src/services/permissions.ts` با `module: 'تلفن'`. همه از سازوکار موجود دامنه واحد (`user_roles.scope_unit_id` و `AuthUser.unitsFor`) پشتیبانی می‌کنند.

| کلید | نام فارسی | admin | it | manager | president | secretariat | expert |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `telephony.settings.manage` | تنظیم اتصال مرکز تلفن | ✓ | ✓ | | | | |
| `telephony.extensions.view` | مشاهده داخلی‌ها | ✓ | ✓ | ✓ واحد | | | |
| `telephony.extensions.assign` | تخصیص داخلی | ✓ | ✓ | | | | |
| `telephony.extensions.request` | درخواست تغییر داخلی | ✓ | ✓ | | | | |
| `telephony.extensions.approve` | تأیید تغییر داخلی | ✓ | | | | | |
| `telephony.extensions.provision` | اطلاعات راه‌اندازی دستگاه | | ✓ | | | | |
| `telephony.presence.view` | مشاهده وضعیت داخلی همکاران | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `telephony.call` | تماس با یک کلیک | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `telephony.calls.view_own` | مشاهده تماس‌های خود | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `telephony.calls.view_unit` | مشاهده تماس‌های واحد (با دامنه نقش) | ✓ | | ✓ واحد | ✓ | | |
| `telephony.calls.view_all` | مشاهده همه تماس‌ها | ✱ | | | | | |
| `telephony.calls.link` | اتصال تماس به پرونده | ✓ | | ✓ | ✓ | ✓ | ✓ |
| `telephony.calls.annotate` | ویرایش یادداشت تماس دیگران | ✓ | | ✓ واحد | | | |
| `telephony.calls.export` | خروجی Excel از تاریخچه | ✓ | | ✓ واحد | ✓ | | |
| `telephony.numbers.view_full` | دیدن شماره کامل طرف بیرونی | ✓ | | ✓ | ✓ | ✓ | |
| `telephony.dial_policy.manage` | تنظیم دسته شماره، سیاست شماره‌گیری و فهرست مسدود | ✓ | ✓ | | | | |
| `telephony.recordings.listen` | شنیدن ضبط تماس (در صورت وجود) | ✱ | | | | | |
| `telephony.recordings.download` | دریافت فایل ضبط (جدا از شنیدن) | ✱ | | | | | |
| `contacts.view` / `contacts.manage` | مخاطبان (آینده) | ✓ | | ✓ | ✓ | ✓ | view |

نکات:

- **✱ مجوز حساس به حریم خصوصی:** در کد فعلی نقش `admin` با `permissions: all` در `SYSTEM_ROLES` تعریف شده و هر مجوز جدید را خودکار می‌گیرد. برای اجرای تصمیم D7، پیشنهاد می‌شود فهرست کوچکی از مجوزهای حساس (`telephony.calls.view_all`، `telephony.recordings.listen`، `telephony.recordings.download`) از `all` مستثنا شود و فقط با انتساب صریح نقش جداگانه (مثلاً نقش جدید «ناظر تماس») داده شود. این تنها تغییر پیشنهادی در منطق نقش‌های موجود است و دلیل فنی آن همین اعطای خودکار است. تصمیم نهایی: `open-questions.md` F3.
- `it` تاریخچه تماس دیگران و ضبط را نمی‌بیند (تفکیک وظیفه فنی از دسترسی به محتوای کاری).
- «✓ واحد» یعنی انتساب نقش با `scope_unit_id`؛ مدیر واحد (`managedUnits`) مانند `letterVisibleSql` دامنه واحد خود را دارد.
- مجوزهای ضبط فقط معنا دارند اگر داشتن ضبط در PBX تأیید شود (C7)؛ حتی با مجوز ضبط، کاربر باید خود تماس را هم ببیند (بخش ۳).

## ۳. ABAC و دید تماس

تابع پیشنهادی `callVisibleSql(u, params, alias)` در `services/access.ts` (هم‌سبک `letterVisibleSql`):

```
(
     call.user_id = me                                                  -- کارمند: تماس‌های خودش
  OR EXISTS (call_parties cp WHERE cp.call_id = call.id AND cp.user_id = me)
  OR (call.unit_id = ANY(unitsFor('telephony.calls.view_unit') ∪ managedUnits))   -- واحد: با دامنه نقش یا مدیر واحد
  OR unitsFor('telephony.calls.view_all') IS NULL                       -- نقش مجاز: همه
)
AND call.confidentiality <= u.clearance
```

سه محور دسترسی تصمیم D7 به این شکل اعمال می‌شود: **کارمند** (تماسی که خودش طرف آن بوده)، **واحد سازمانی** (`calls.unit_id` که در لحظه تماس از تخصیص داخلی ثبت شده و با جابه‌جایی بعدی کارمند تغییر نمی‌کند)، و **نقش** (مجوز با یا بدون دامنه واحد). گزارش‌ها و خروجی Excel همین شرط را اعمال می‌کنند.

- تماسی که به نامه یا سند طبقه‌بندی‌شده پیوند می‌خورد، `confidentiality` آن به بیشینه طبقه موجودیت‌های پیوندی ارتقا می‌یابد (هرگز کاهش خودکار).
- پیوندها فقط برای کاربری نمایش داده می‌شوند که هم تماس و هم موجودیت مقصد را ببیند.
- تماس یا موجودیت نامرئی ۴۰۴ برمی‌گرداند (عدم افشای وجود).

## ۴. اسرار

| راز | محل | دسترسی |
|---|---|---|
| گذرواژه کاربر AMI | `telephony_connections.secret_enc` (`purpose='ami'`) | فقط آداپتور AMI در حافظه سرور |
| اعتبارنامه API مدیریتی Issabel | `telephony_connections.secret_enc` (`purpose='config_api'`)؛ توکن کوتاه‌عمر حاصل فقط در حافظه (الگوی `tokenCache` در `integration/meetings.ts`) | فقط آداپتور پیکربندی |
| اعتبارنامه پایگاه CDR (کاربر فقط‌خواندنی و فقط `SELECT` روی جدول CDR/CEL) | `telephony_connections.secret_enc` (`purpose='cdr_db'`) | فقط `CdrSource` |
| Secret SIP داخلی‌های جدید | **ذخیره نمی‌شود**؛ تولید با `crypto.randomBytes` و ارسال مستقیم به آداپتور | نمایش یک‌باره با `telephony.extensions.provision` |
| کلید رمزنگاری | `DATA_ENCRYPTION_KEY` موجود در `config.ts` | بدون تغییر |

قواعد:

- `GET` هیچ‌گاه راز برنمی‌گرداند (`hasSecret: boolean`، مانند `GET /integrations`).
- لاگ `pino` با `redact` برای کلیدهای `secret`، `password`، `Secret` در پیام‌های AMI.
- پیام خطای PBX پیش از ذخیره در `last_error` پاک‌سازی می‌شود (حذف خطوط حاوی `Secret:`/`password`) و به ۵۰۰ کاراکتر محدود می‌شود.
- کاربر AMI با حداقل مجوز: `read` فقط کلاس‌های لازم (مانند `call,cdr,reporting` یا معادل نسخه) و `write` فقط `originate` (و در صورت نیاز `call`)؛ **بدون** `system`، `command`، `config` و `all`. تأیید نهایی با مدیر مرکز تلفن.
- چرخش راز: تغییر راز در UI → آزمون اتصال → ذخیره؛ راز قبلی نگه داشته نمی‌شود.
- هیچ گذرواژه، کلید یا توکنی در مستندات، کد، مهاجرت، seed یا تست ثابت نوشته نمی‌شود؛ تست‌ها از `FakePbx` استفاده می‌کنند.

## ۵. ممیزی

از `audit(db, req, entry)` در `lib/audit.ts` و درون همان تراکنش تغییر. به‌دلیل قفل سراسری ممیزی، فقط **اقدامات انسانی و تغییرات مدیریتی** ممیزی می‌شوند؛ رویدادهای خودکار تماس در `calls`/`call_events` می‌مانند.

| action | entity | ثبت در before/after |
|---|---|---|
| `telephony.connection.updated` | `telephony_connection` | میزبان، پورت، TLS، کاربر، `secretChanged`؛ بدون راز |
| `telephony.connection.tested` | `telephony_connection` | نتیجه و تأخیر |
| `telephony.settings.updated` | `integration` | تنظیمات قبل/بعد |
| `telephony.extension.assigned` / `.unassigned` / `.reassigned` | `pbx_extension` | تخصیص قبل/بعد |
| `telephony.change.requested` / `.submitted` / `.approved` / `.rejected` / `.cancelled` | `extension_change_request` | payload و دلیل |
| `telephony.change.applied` / `.failed` | `extension_change_request` | نتیجه خلاصه PBX، کد خطا (`userId` = سامانه، مانند intake) |
| `telephony.change.drift_detected` | `pbx_extension` | snapshot قبل/بعد (بدون راز) |
| `telephony.dial_policy.created` / `.updated` / `.deleted` | `telephony_dial_policy` | سیاست قبل/بعد |
| `telephony.number_class.updated`، `telephony.blocked_number.added` / `.removed` | `telephony_number_class` / `telephony_blocked_number` | قبل/بعد |
| `telephony.recording.played` / `.downloaded` | `call_recording` | تماس، دلیل (برای دریافت) |
| `telephony.call.linked` / `.unlinked` | `call` | نوع و شناسه موجودیت |
| `telephony.call.annotated` | `call` | یادداشت قبل/بعد |
| `telephony.calls.exported` | `call` | فیلترها و تعداد ردیف |
| `telephony.provision.viewed` | `pbx_extension` | فقط «نمایش داده شد» |

**آنچه ممیزی نمی‌شود (ثبت عملیاتی):** رویدادهای تماس، ردیف‌های CDR، تغییر وضعیت داخلی‌ها، و درخواست‌های تماس با یک کلیک (پذیرفته یا ردشده) که با نتیجه کامل در `click_to_call_requests` ثبت می‌شوند. این جداول از کاربران عادی فقط‌خواندنی‌اند و کد برنامه ردیف آن‌ها را حذف نمی‌کند جز کار نگهداری.

مشاهده عادی فهرست تماس‌ها ممیزی نمی‌شود؛ مشاهده تماس‌های دیگران با `view_all` (اختیاری، با تصمیم سازمان) ممیزی شود.

## ۶. مدیریت خطا و امنیت عملیاتی

- همه خطاهای آداپتور به `HttpError` با کدهای `pbx_*` تبدیل می‌شوند (الگوی `meetingsRequest`)؛ جزئیات فنی فقط در لاگ سرور.
- `GET /metrics` با شمارنده‌های `telephony_ami_connected`، `telephony_events_total`، `telephony_originate_total{result}`، `telephony_sync_drift`، `telephony_cdr_lag_seconds` (با `lib/metrics.ts`).
- هشدار `telephony.connection_down` به دارندگان `telephony.settings.manage` پس از ۵ دقیقه قطعی (یک‌بار در هر رخداد).
- MFA: پیشنهاد افزودن نقش‌های دارای `telephony.settings.manage` و `telephony.extensions.approve` به `MFA_REQUIRED_ROLES`.

## ۷. حریم خصوصی

- ضبط مکالمه در دامنه این طرح **نیست**. اگر بعداً لازم شد، با مجوز جدا (`telephony.recordings.listen`)، ممیزی هر پخش، و الزامات قانونی جدا طراحی شود.
- اطلاع‌رسانی به کارکنان درباره ثبت فراداده تماس (چه کسی، کی، چقدر) پیش از فعال‌سازی، بر عهده سازمان.
- نگهداری و ناشناس‌سازی طبق `telephony-data-model.md` بخش ۶.

## ۸. محدودیت شماره و جلوگیری از سوءاستفاده (تصمیم D8)

| لایه | کنترل | محل |
|---|---|---|
| ۱. Issabel | Outbound Routes و محدودیت‌های موجود همچنان اعمال می‌شوند چون Originate در Context عادی داخلی‌ها انجام می‌شود، نه Context ویژه | پیکربندی PBX (بدون تغییر از سمت ما) |
| ۲. مالکیت | فقط از داخلی تخصیص‌یافته به خود کاربر | `extension_assignments` |
| ۳. فهرست مسدود | شماره یا پیشوند مسدود همیشه رد می‌شود | `telephony_blocked_numbers` |
| ۴. دسته و سیاست | دسته شماره (داخلی، اضطراری، شهری، همراه، سراسری، رایگان، ویژه، بین‌المللی) باید در سیاست نقش/واحد کاربر مجاز باشد؛ پیش‌فرض فقط داخلی؛ ویژه و بین‌المللی در هیچ سیاست پیش‌فرضی نیستند | `telephony_number_classes`، `telephony_dial_policies` |
| ۵. سقف | سقف ساعتی و روزانه هر سیاست، حداکثر یک تماس هم‌زمان در حال زنگ، ساعت کاری اختیاری | شمارش `click_to_call_requests` |
| ۶. تکرار | `idempotencyKey` از دوبار زدن دکمه جلوگیری می‌کند | `click_to_call_requests` |
| ۷. ثبت نتیجه | هر درخواست با وضعیت نهایی، دلیل رد، پاسخ PBX، دسته شماره و سیاست اعمال‌شده | `click_to_call_requests` |
| ۸. هشدار | رد پیاپی، رسیدن به سقف، یا حجم غیرعادی تماس یک کاربر → اعلان `telephony.dial_abuse_suspected` و نمایش در گزارش «عملیات تماس ردشده» | زمان‌بند + `notify` |
| ۹. توقف اضطراری | غیرفعال کردن اتصال AMI یا سیاست‌ها، همه تماس‌های با یک کلیک را فوراً متوقف می‌کند بدون اثر روی تلفن‌های فیزیکی | `telephony_connections.is_active` |
