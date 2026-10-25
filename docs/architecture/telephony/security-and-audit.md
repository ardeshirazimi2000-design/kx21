# امنیت، مجوزها، اسرار و ممیزی ماژول تلفن

## ۱. مدل تهدید (خلاصه)

| تهدید | پیامد | کنترل |
|---|---|---|
| دسترسی مستقیم به AMI از شبکه کاربران | کنترل کامل تماس‌ها، شنود فراداده، Originate دلخواه | AMI فقط از IP سرور اتوماسیون (`permit/deny` در `manager.conf` و فایروال PBX)؛ TLS یا شبکه مدیریتی جدا؛ مرورگر هرگز اطلاعات اتصال نمی‌بیند |
| سوءاستفاده از تماس با یک کلیک (Toll Fraud) | هزینه تماس بین‌المللی/ویژه | فقط از داخلی خود کاربر، الگوی مجاز/ممنوع مقصد، محدودیت نرخ، ممیزی هر درخواست، Originate فقط در Context عادی تا Outbound Routes و محدودیت‌های Issabel اعمال شود |
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
| `telephony.calls.view_unit` | مشاهده تماس‌های واحد | ✓ | | ✓ واحد | ✓ | | |
| `telephony.calls.view_all` | مشاهده همه تماس‌ها | ✓ | | | | | |
| `telephony.calls.link` | اتصال تماس به پرونده | ✓ | | ✓ | ✓ | ✓ | ✓ |
| `telephony.calls.annotate` | ویرایش یادداشت تماس دیگران | ✓ | | ✓ واحد | | | |
| `telephony.numbers.view_full` | دیدن شماره کامل طرف بیرونی | ✓ | | ✓ | ✓ | ✓ | |
| `contacts.view` / `contacts.manage` | مخاطبان (در صورت تأیید) | ✓ | | ✓ | ✓ | ✓ | view |

نکات:

- `admin` طبق الگوی فعلی (`permissions: all`) همه را دارد. پیشنهاد: `telephony.calls.view_all` برای مدیر سیستم هم به تصمیم سازمان واگذار شود (حریم خصوصی) و در `open-questions.md` آمده است.
- `it` تاریخچه تماس دیگران را نمی‌بیند (تفکیک وظیفه فنی از دسترسی به محتوای کاری).
- «✓ واحد» یعنی انتساب نقش با `scope_unit_id`؛ مدیر واحد (`managedUnits`) مانند `letterVisibleSql` دامنه واحد خود را دارد.

## ۳. ABAC و دید تماس

تابع پیشنهادی `callVisibleSql(u, params, alias)` در `services/access.ts` (هم‌سبک `letterVisibleSql`):

```
call.user_id = me
OR EXISTS (call_parties cp WHERE cp.call_id = call.id AND cp.user_id = me)
OR (can view_unit AND call.unit_id = ANY(units))
OR view_all
AND call.confidentiality <= u.clearance
```

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
| `telephony.call.originated` | `click_to_call_request` | داخلی، مقصد پوشانده، زمینه |
| `telephony.call.linked` / `.unlinked` | `call` | نوع و شناسه موجودیت |
| `telephony.call.annotated` | `call` | یادداشت قبل/بعد |
| `telephony.calls.exported` | `call` | فیلترها و تعداد ردیف |
| `telephony.provision.viewed` | `pbx_extension` | فقط «نمایش داده شد» |

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
