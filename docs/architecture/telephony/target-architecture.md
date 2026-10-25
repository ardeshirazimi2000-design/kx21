# معماری هدف ماژول تلفن (Issabel/Asterisk)

> وابسته به: `current-state-analysis.md`. هر جا به رفتار Issabel اشاره شده و در `open-questions.md` تأیید نشده، فرض طراحی است و قبل از پیاده‌سازی باید تأیید شود. فهرست جداگانه موارد نامشخص در `open-questions.md` بخش ۰ آمده است.

## ۰. تصمیم‌های مصوب (۲۰۲۶-۱۰-۲۵)

| # | تصمیم | محل اعمال در اسناد |
|---|---|---|
| D1 | فاز ۱ فقط اتصال امن، مشاهده داخلی‌های موجود و نگاشت داخلی به کارمند؛ **هیچ تغییری در پیکربندی Issabel** | `implementation-roadmap.md` فاز ۱؛ در فاز ۱ فقط آداپتورهای فقط‌خواندنی ساخته می‌شوند |
| D2 | تاریخچه تماس فاز ۲، تماس با یک کلیک فاز ۳ | `implementation-roadmap.md` |
| D3 | ایجاد، ویرایش و غیرفعال‌سازی داخلی در فاز ۴، مگر اینکه مستندات نسخه واقعی امکان جلوآوردن را اثبات کند | `implementation-roadmap.md` بخش ۳ (شرایط جلوآوردن) |
| D4 | صف‌ها و مسیریابی فاز ۵ | `implementation-roadmap.md` |
| D5 | دفترچه مخاطبان در معماری پیش‌بینی می‌شود ولی در فاز ۱ ساخته نمی‌شود | بخش ۱۰ همین سند، `telephony-data-model.md` بخش ۳.۷ |
| D6 | تاریخچه تماس از ممیزی تغییرات مدیریتی جدا است | اصل ۷ همین سند، `security-and-audit.md` بخش ۵ |
| D7 | دسترسی به تاریخچه بر اساس کارمند، واحد و نقش؛ ضبط تماس مجوز جدا | `security-and-audit.md` بخش ۲ و ۳ |
| D8 | محدودیت شماره‌های مجاز، جلوگیری از سوءاستفاده و ثبت نتیجه عملیات تماس | `security-and-audit.md` بخش ۸، `telephony-data-model.md` بخش ۳.۸ |
| D9 | هیچ روش مدیریتی Issabel بدون شناخت نسخه و رابط‌ها قطعی فرض نمی‌شود | بخش ۴ همین سند (آداپتور با کشف قابلیت) |
| D10 | استفاده مجدد از `jobs`، `integration_inbox`، رمزنگاری و ممیزی؛ تغییر فقط با دلیل فنی | بخش ۹ همین سند |

## ۱. اصول

1. **بدون زیرساخت موازی:** ماژول داخل `apps/office-api` ساخته می‌شود و از پایگاه `kx_office`، صف `jobs`، صندوق `integration_inbox`، `lib/crypto.ts`، `lib/audit.ts` و RBAC موجود استفاده می‌کند. سرویس، پایگاه یا Broker جدید اضافه نمی‌شود. ارزیابی دقیق هر جزء و دو مورد استثنا با دلیل فنی در بخش ۹.
2. **مرورگر هرگز به مرکز تلفن وصل نمی‌شود.** AMI، ARI، API مدیریتی و پایگاه CDR فقط از سمت سرور office-api قابل دسترسی‌اند.
3. **سه رابط جدا با سه اعتبارنامه جدا:**
   - **رابط پیکربندی** (مدیریت داخلی‌ها): فقط روش رسمی نسخه نصب‌شده. راهنمای رسمی Issabel یک REST API با احراز هویت JWT (کنترلرها در `/var/www/html/pbxapi/controllers`) معرفی می‌کند که برای داخلی‌ها و گروه‌های زنگ عملیات پرس‌وجو، ایجاد، ویرایش و حذف را مستند کرده و تغییرات را خودکار اعمال (Reload) می‌کند؛ همان راهنما می‌گوید ممکن است ناقص یا نادرست باشد و نسخه ارائه آن را ذکر نکرده است ([منبع](https://ccmanual.issabel.com/en/api/issabel-api.html)). بنابراین وجود و رفتار آن روی سرور واقعی **نامشخص** است. بدون تأیید آن، فقط حالت «فقط‌خواندنی + ثبت دستی».
   - **رابط کنترل تماس** (AMI): Originate برای تماس با یک کلیک، رویدادهای تماس و وضعیت داخلی.
   - **منبع تاریخچه** (CDR): خواندن فقط‌خواندنی جدول CDR یا رویداد `Cdr` از AMI.
4. **سه وضعیت جدا:** وضعیت همگام‌سازی پیکربندی داخلی، وضعیت عملیاتی داخلی (Device State) و وضعیت تماس هرگز در یک فیلد ترکیب نمی‌شوند.
5. **قطع Issabel هسته را مختل نمی‌کند:** تمام فراخوانی‌های تلفن ناهمگام یا با Timeout کوتاه هستند؛ خطای تلفن فقط بخش تلفن را «در دسترس نیست» نشان می‌دهد. داده‌های کاربران، نامه‌ها و نگاشت داخلی‌ها در `kx_office` می‌مانند.
6. **منبع حقیقت:** برای پیکربندی داخلی، **Issabel** منبع حقیقت است و اتوماسیون «آینه + درخواست تغییر» دارد. برای تخصیص داخلی به کارمند و اتصال تماس به پرونده، **اتوماسیون** منبع حقیقت است.
7. **دو جریان ثبت جدا:**
   - **ممیزی** (`audit_logs` از طریق `lib/audit.ts`): فقط اقدامات انسانی و تغییرات مدیریتی کم‌حجم مانند تنظیم اتصال، تخصیص داخلی، درخواست و تأیید تغییر، تغییر سیاست شماره‌گیری، پیوند تماس به پرونده و دسترسی به ضبط تماس.
   - **ثبت عملیاتی تماس** (`calls`، `call_parties`، `call_events`، `cdr_records`، `click_to_call_requests`): همه رویدادهای خودکار و پرحجم و نتیجه هر عملیات تماس. این جداول قفل زنجیره ممیزی را نمی‌گیرند و سیاست نگهداری جدا دارند.
   - هیچ رویداد تماسی وارد `audit_logs` نمی‌شود. اگر کاری روی تماس انسانی و مدیریتی باشد (مثلاً خروجی گرفتن از تاریخچه)، فقط **خود اقدام** ممیزی می‌شود، نه ردیف‌های تماس.
8. **کشف قابلیت پیش از استفاده:** هر آداپتور در شروع، نسخه و قابلیت‌های واقعی را کشف و در `telephony_connections.settings.discovered` ذخیره می‌کند. منطق دامنه فقط بر اساس قابلیت کشف‌شده رفتار می‌کند و هیچ عمل مدیریتی بر اساس فرض نسخه فعال نمی‌شود.

## ۲. نمای کلی

```mermaid
flowchart LR
  subgraph Browser["مرورگر (office-web)"]
    UI[صفحات تلفن<br/>داخلی‌ها · تاریخچه · دکمه تماس]
  end
  subgraph OfficeAPI["office-api (همان کد، همان پایگاه)"]
    R[routes/telephony.ts<br/>requirePerm + audit]
    S[services/telephony/*<br/>منطق دامنه]
    Q[(jobs + integration_inbox)]
    L[شنونده تلفن<br/>اتصال ماندگار AMI · تک‌نمونه]
    A1[ConfigAdapter<br/>API مدیریتی Issabel]
    A2[CallControlAdapter<br/>AMI]
    A3[CdrSource<br/>CDR فقط‌خواندنی]
  end
  DB[(PostgreSQL kx_office)]
  subgraph PBX["Issabel / Asterisk (شبکه داخلی)"]
    API[API مدیریتی<br/>نامشخص]
    AMI[AMI 5038/5039]
    CDR[(asteriskcdrdb)]
  end
  UI -->|HTTPS + JWT| R --> S --> DB
  S --> Q
  Q --> A1 --> API
  S --> A2 --> AMI
  L --> AMI
  L --> DB
  Q --> A3 --> CDR
  R -.->|SSE فاز تماس لحظه‌ای| UI
```

## ۳. اجزا و مرز مسئولیت

| جزء | مسیر پیشنهادی | مسئولیت | نیست |
|---|---|---|---|
| مسیرها | `apps/office-api/src/routes/telephony.ts` | اعتبارسنجی zod، `requirePerm`، تراکنش و `audit`، پاسخ بدون اسرار | تماس مستقیم با PBX در مسیر درخواست (به‌جز Originate با Timeout کوتاه) |
| دامنه | `apps/office-api/src/services/telephony/` (`extensions.ts`، `calls.ts`، `links.ts`، `numbers.ts`) | قواعد تخصیص، Maker-Checker، نرمال‌سازی شماره، تطبیق تماس با کاربر و مخاطب | جزئیات پروتکل |
| آداپتورها | `apps/office-api/src/integration/telephony/` (`config-adapter.ts`، `ami.ts`، `cdr.ts`) | ترجمه پروتکل، Timeout، تبدیل خطا به `HttpError` با کدهای `pbx_*` | تصمیم کسب‌وکار |
| شنونده | `apps/office-api/src/integration/telephony/listener.ts` با پرچم `TELEPHONY_LISTENER_ENABLED` | اتصال ماندگار AMI، اتصال مجدد با Backoff، تجمیع رویدادها بر اساس `Linkedid`، به‌روزرسانی `calls` و `pbx_extensions.device_state` | پردازش کند یا تماس با سرویس بیرونی |
| کارهای صف | `registerHandler('telephony.*')` | اعمال تغییر داخلی، همگام‌سازی فهرست داخلی‌ها، برداشت CDR، تطبیق CDR با تماس زنده | — |
| زمان‌بند | افزودن به `services/scheduler.ts` | صف‌کردن همگام‌سازی داخلی‌ها و برداشت CDR در فاصله تنظیم‌شده | — |
| UI | `apps/office-web/src/pages/Telephony*.tsx`، مؤلفه `CallButton` | نمایش و درخواست؛ هیچ اطلاعات اتصال PBX | — |

### چرا شنونده جدا از Worker؟

AMI یک اتصال TCP ماندگار است و رویدادها را Push می‌کند. Worker فعلی (`services/jobs.ts`) و Scheduler بر پایه `setInterval` هستند و می‌توانند چند نمونه داشته باشند. شنونده باید **دقیقاً یک نمونه** باشد (مانند `SCHEDULER_ENABLED`) تا رویداد تکراری و اتصال‌های متعدد ایجاد نشود. همان تصویر Docker با متغیر محیطی، نه سرویس جدید. برای جلوگیری از دو شنونده هم‌زمان، قفل مشورتی `pg_try_advisory_lock(hashtext('telephony-listener'))` در شروع گرفته می‌شود.

## ۴. رابط‌های آداپتور (قرارداد)

```ts
interface PbxConfigAdapter {            // فقط اگر روش رسمی تأیید شود؛ وگرنه ReadOnlyConfigAdapter
  capabilities(): Promise<{ list: boolean; create: boolean; update: boolean; disable: boolean; remove: boolean; applyConfig: boolean }>;
  listExtensions(): Promise<PbxExtension[]>;
  getExtension(ext: string): Promise<PbxExtension | null>;
  createExtension(input: ExtensionSpec, idempotencyKey: string): Promise<ApplyResult>;
  updateExtension(ext: string, patch: Partial<ExtensionSpec>, idempotencyKey: string): Promise<ApplyResult>;
  disableExtension(ext: string, idempotencyKey: string): Promise<ApplyResult>;
  deleteExtension(ext: string, idempotencyKey: string): Promise<ApplyResult>;
}

interface CallControlAdapter {          // AMI
  originate(req: { fromExtension: string; to: string; callerName?: string; actionId: string; vars: Record<string, string> }): Promise<{ accepted: boolean }>;
  extensionState(ext: string): Promise<DeviceState>;
  ping(): Promise<number>;              // میلی‌ثانیه
}

interface CdrSource {
  fetchSince(cursor: CdrCursor, limit: number): Promise<{ rows: CdrRow[]; next: CdrCursor }>;
}
```

- در فاز ۱ تا ۳ فقط متدهای خواندنی (`capabilities`، `listExtensions`، `getExtension`) پیاده می‌شوند و متدهای نوشتن حتی در کد وجود ندارند (تصمیم D1). متدهای نوشتن فقط در فاز ۴ و پس از تأیید رابط واقعی اضافه می‌شوند.
- `ReadOnlyConfigAdapter`: اگر API مدیریتی وجود نداشته باشد، فهرست داخلی‌ها از رویدادهای/دستورات فقط‌خواندنی AMI (مانند `PJSIPShowEndpoints` یا `SIPpeers` بسته به درایور) یا ورود دستی/فایل CSV ساخته می‌شود و `create/update/disable/remove` غیرفعال‌اند. UI در این حالت «درخواست تغییر» را به‌صورت تیکت برای مدیر مرکز تلفن ثبت می‌کند و پس از اعمال دستی، همگام‌سازی آن را تأیید می‌کند.
- `FakePbx`: پیاده‌سازی درون‌حافظه برای آزمون‌ها (مثل `outbox` در `notifications.ts`). در CI هیچ اتصال واقعی نیست.

## ۵. جریان داده‌ها

| جریان | سازوکار | حذف تکرار |
|---|---|---|
| فهرست داخلی‌ها از PBX | کار `telephony.sync_extensions` (دوره‌ای و دستی) → مقایسه با `pbx_extensions` → `sync_status` | کلید `(pbx_key, extension)` |
| تغییر داخلی | درخواست → تأیید → کار `telephony.apply_change` → آداپتور → بازخوانی و تأیید | `idempotency_key` درخواست؛ قبل از اعمال، وضعیت فعلی در PBX خوانده می‌شود |
| رویداد زنده تماس | شنونده AMI → به‌روزرسانی `calls` و `call_events` در حافظه تجمیع و هر رویداد معنادار یک UPSERT | `calls.pbx_linkedid` یکتا؛ `call_events (call_id, pbx_uniqueid, event_type, seq)` یکتا |
| تاریخچه نهایی | کار `telephony.pull_cdr` با مکان‌نما در `integrations.state` (الگوی `pollEvents`) | کلید `(pbx_key, cdr_uniqueid, cdr_sequence)` |
| تماس با یک کلیک | API → اعتبارسنجی → `click_to_call_requests` → Originate با `ActionID` | `idempotency_key` از سمت مرورگر؛ جلوگیری از دوبار کلیک |

`integration_inbox` فقط برای رویدادهای کم‌حجم و مهم استفاده می‌شود (مثلاً نتیجه اعمال تغییر یا رویدادهای Webhook احتمالی). رویدادهای خام AMI پرحجم‌اند و مستقیم در جداول عملیاتی تلفن تجمیع می‌شوند تا صندوق و ممیزی شلوغ نشوند.

## ۶. تحمل خطا

- مدار قطع (Circuit Breaker) ساده برای هر اتصال: پس از N خطای پیاپی، حالت `degraded` در `telephony_connections.health` و توقف تلاش تا زمان بازبینی؛ UI بنر «مرکز تلفن در دسترس نیست».
- شنونده AMI: اتصال مجدد با Backoff نمایی تا ۶۰ ثانیه؛ پس از اتصال مجدد، تماس‌های «زنده» که رویداد پایان نگرفته‌اند با CDR تطبیق داده می‌شوند (`call-lifecycle.md`).
- Timeoutها: Originate ۵ ثانیه، API مدیریتی ۱۵ ثانیه، پرس‌وجوی CDR ۳۰ ثانیه.
- هیچ مسیر هسته (نامه، کارتابل، ورود) به ماژول تلفن وابسته نیست؛ دکمه تماس در صورت خطا غیرفعال می‌شود.

## ۷. استقرار

- همان کانتینر `office-api`. نمونه‌ای که `TELEPHONY_LISTENER_ENABLED=true` دارد باید از شبکه کانتینر به IP مرکز تلفن مسیر داشته باشد.
- ارتباط AMI ترجیحاً روی TLS (پورت ۵۰۳۹) یا تونل/VLAN مدیریتی؛ `permit/deny` در `manager.conf` فقط برای IP سرور اتوماسیون (تنظیم سمت PBX توسط مدیر مرکز تلفن).
- هیچ پورت جدیدی از office-api به بیرون باز نمی‌شود، مگر Webhook احتمالی که فعلاً لازم نیست.

## ۸. تصمیم‌های معماری و جایگزین‌های ردشده

| تصمیم | گزینه ردشده | دلیل |
|---|---|---|
| ماژول داخل office-api | میکروسرویس تلفن جدا | پشته و پایگاه واحد، استقرار ساده، استفاده از RBAC و ممیزی موجود؛ مرز آداپتور امکان جداسازی بعدی را حفظ می‌کند |
| AMI برای کنترل تماس | ARI | ARI برای کنترل کامل تماس در اپلیکیشن Stasis است و dialplan را دور می‌زند؛ برای Originate و رویداد لازم نیست و ریسک اختلال در مسیریابی فعلی را دارد |
| API مدیریتی رسمی برای داخلی‌ها | نوشتن مستقیم در MySQL Issabel یا فایل‌های `*.conf` | دور زدن اعتبارسنجی Issabel، بازنویسی با Apply Config، شکستن ارتقای نسخه؛ طبق اصل ۴ مأموریت ممنوع است مگر با مستند و تأیید |
| CDR فقط‌خواندنی | فقط رویدادهای AMI | AMI در قطعی شبکه رویداد را از دست می‌دهد؛ CDR منبع نهایی و قابل بازسازی است |
| SSE برای لحظه‌ای | WebSocket | یک‌طرفه کافی است، با Express و JWT ساده‌تر است و کتابخانه جدید نمی‌خواهد |

## ۹. ارزیابی استفاده مجدد از زیرساخت موجود

| جزء موجود | محل در کد | نتیجه | دلیل فنی |
|---|---|---|---|
| صف پایدار `jobs` | `services/jobs.ts` (`enqueue`، `registerHandler`، `processJobs`) | **استفاده بدون تغییر** | برای کارهای کم‌بسامد و قابل تلاش مجدد مناسب است: همگام‌سازی داخلی‌ها، برداشت CDR، اعمال درخواست تغییر (فاز ۴)، اعلان. تلاش مجدد نمایی و `max_attempts` موجود کافی است. |
| — | — | **استفاده نکردن برای رویدادهای زنده AMI** | هر رویداد یک ردیف `jobs` و یک `UPDATE` وضعیت می‌سازد و Worker هر ۵ ثانیه (`WORKER_INTERVAL_SECONDS`) فقط ۲۰ کار برمی‌دارد؛ برای ده‌ها رویداد در هر تماس هم تأخیر و هم بار نوشتن غیرضروری دارد. شنونده رویدادها را در حافظه بر اساس `Linkedid` تجمیع و مستقیم در `calls` ثبت می‌کند. |
| صندوق `integration_inbox` | `001_init.sql` خط ۴۰۳، `receiveEvent` در `integration/meetings.ts` | **استفاده محدود** با `system='telephony'` | الگوی حذف تکرار با `UNIQUE (system, event_id)` برای رویدادهای کم‌حجم و مهم مناسب است (مثلاً نتیجه اعمال تغییر یا رویداد ورودی آینده از PBX). |
| — | — | **استفاده نکردن برای رویدادهای خام AMI و ردیف‌های CDR** | جدول پیام کامل `payload` را نگه می‌دارد و سیاست نگهداری یا پارتیشن ندارد؛ هر ردیف یک کار صف جدا می‌سازد. حذف تکرار تماس با قید یکتای `calls (pbx_key, pbx_linkedid)` و `cdr_records (pbx_key, cdr_uniqueid, cdr_sequence)` همان تضمین را بدون این هزینه می‌دهد. |
| رمزنگاری اسرار | `lib/crypto.ts` (`encryptText`، `decryptText`، AES-256-GCM با `DATA_ENCRYPTION_KEY`) | **استفاده بدون تغییر** | برای هر سه راز اتصال کافی است. |
| جدول `integrations` برای اسرار | `001_init.sql` خط ۳۸۵ | **تغییر با دلیل** (جدول `telephony_connections`) | `integrations` برای هر `kind` یک ردیف یکتا و فقط یک راز خروجی (`client_secret_enc`) دارد، ولی تلفن سه اعتبارنامه مستقل با سه سطح دسترسی (API مدیریتی، AMI، پایگاه CDR) می‌خواهد. یک ردیف `integrations` با `kind='telephony'` برای وضعیت کلی، تنظیمات و مکان‌نمای CDR (`state`) نگه داشته می‌شود تا در صفحه یکپارچه‌سازی موجود دیده شود. |
| ممیزی زنجیره‌ای | `lib/audit.ts` (`audit`، `verifyAuditChain`) | **استفاده بدون تغییر برای اقدامات مدیریتی** | زنجیره هش، تریگر عدم تغییر و ثبت درون تراکنش دقیقاً همان چیزی است که تغییرات حساس تلفن لازم دارند. |
| — | — | **استفاده نکردن برای رویدادهای تماس** | هر `audit()` قفل سراسری `pg_advisory_xact_lock(hashtext('audit'))` می‌گیرد و آخرین هش را می‌خواند؛ نوشتن هم‌زمان رویدادهای تماس همه تراکنش‌های ممیزی سامانه (نامه، امضا، کاربران) را صف‌بندی می‌کند. تصمیم D6. |
| RBAC با دامنه واحد | `auth/middleware.ts` (`can`، `unitsFor`، `managedUnits`) | **استفاده بدون تغییر** | دامنه کارمند/واحد/همه برای تاریخچه تماس با همین سازوکار پیاده می‌شود. |
| ABAC | `services/access.ts` | **افزودن تابع هم‌سبک** `callVisibleSql` | بدون تغییر توابع موجود. |
| اعلان | `services/notifications.ts` (`notify`) | **استفاده؛ افزودن رویداد** به `NOTIFICATION_EVENTS` | — |
| زمان‌بند | `services/scheduler.ts` | **استفاده؛ افزودن صف‌کردن کارهای تلفن** | — |
| شنونده ماندگار | ندارد | **افزودن** (تنها جزء زیرساختی جدید، فاز ۳) | هیچ جزء موجود اتصال TCP ماندگار نگه نمی‌دارد. همان کد و تصویر Docker، با پرچم محیطی و قفل مشورتی. |
| SSE | ندارد | **افزودن** (فاز ۳) | لحظه‌ای فعلی فقط `usePoll` هر ۶۰ ثانیه است. |

## ۱۰. دفترچه مخاطبان (پیش‌بینی معماری، خارج از فاز ۱)

- طبق تصمیم D5 ساخت دفترچه در فاز ۱ الزامی نیست. زمان ساخت آن به تصمیم مالک محصول بستگی دارد (`open-questions.md` F1) و پیشنهاد: همراه یا پس از فاز ۲.
- برای اینکه بعداً بدون تغییر ساختار اضافه شود، از ابتدا این نقاط اتصال در طراحی رعایت می‌شوند:
  - `calls.external_number` همیشه به شکل E.164 نرمال ذخیره می‌شود تا تطبیق بعدی با `contact_phones.number` ممکن باشد.
  - `call_links.entity_type` مقدار `contact` را از ابتدا می‌پذیرد.
  - تطبیق خودکار شماره در `services/telephony/numbers.ts` پشت یک تابع `resolveNumber(number)` است که در نبود دفترچه فقط کاربران داخلی را (از طریق داخلی) برمی‌گرداند.
- تا پیش از ساخت دفترچه، تماس فقط به نامه، سند و پوشه بایگانی پیوند می‌خورد.
