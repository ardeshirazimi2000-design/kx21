# مشخصات API ماژول تلفن

همه مسیرها زیر `/api` و پشت `authenticate` و محدودیت نرخ عمومی در `app.ts` هستند، مگر خلاف آن ذکر شود. قالب خطا همان قالب موجود است:

```json
{ "error": { "code": "extension_already_assigned", "message": "این داخلی به کاربر دیگری تخصیص دارد", "details": {} } }
```

صفحه‌بندی با `pageParams` و پاسخ `paged(items, total, page, pageSize)` در `lib/validate.ts` (`{ items, total, page, pageSize }`). تاریخ‌ها ISO-8601 و نمایش شمسی در کلاینت.

**رابط پیکربندی و رابط کنترل تماس جدا هستند:** مسیرهای `/telephony/admin/*` (پیکربندی و اتصال) و `/telephony/extensions/*` (آینه و تخصیص) هرگز Originate نمی‌کنند؛ مسیرهای `/telephony/calls/*` هرگز پیکربندی PBX را تغییر نمی‌دهند.

## فازبندی مسیرها

| فاز | مسیرها |
|---|---|
| ۱ | بخش ۱ (اتصال، آزمون، قابلیت‌ها، سلامت)، بخش ۲ به‌جز «درخواست تغییر پیکربندی»؛ هیچ مسیری در این فاز چیزی در Issabel تغییر نمی‌دهد |
| ۲ | بخش ۳ (تاریخچه، گزارش، اتصال به پرونده) |
| ۳ | بخش ۴ (تماس با یک کلیک و سیاست شماره‌گیری) و بخش ۵ (لحظه‌ای) |
| ۴ | «درخواست تغییر پیکربندی» در بخش ۲ |
| آینده | مخاطبان و ضبط تماس (بخش ۳)، صف‌ها (فاز ۵) |

## ۱. اتصال و تنظیمات (`telephony.settings.manage`)

| روش و مسیر | توضیح | ممیزی |
|---|---|---|
| `GET /telephony/admin/connections` | فهرست اتصال‌ها؛ به‌جای `secret_enc` فقط `hasSecret: boolean` | — |
| `PUT /telephony/admin/connections/:purpose` | ایجاد/به‌روزرسانی اتصال `config_api`، `ami` یا `cdr_db` | `telephony.connection.updated` (بدون راز؛ فقط `secretChanged: true`) |
| `POST /telephony/admin/connections/:purpose/test` | آزمون اتصال با Timeout ۱۰ ثانیه؛ برای AMI فقط Login و `Ping`؛ برای API فقط خواندن نسخه؛ برای CDR فقط `SELECT 1` و شمارش | `telephony.connection.tested` |
| `GET /telephony/admin/capabilities` | خروجی `PbxConfigAdapter.capabilities()` و نسخه‌ها و رابط‌های کشف‌شده (نسخه Issabel/Asterisk، درایور، وجود API مدیریتی، ستون‌های CDR)؛ مبنای تصمیم درباره فاز ۴ | — |
| `PUT /telephony/admin/settings` | محدوده داخلی‌ها، پیش‌شماره‌ها، الگوی مقصد مجاز، فواصل همگام‌سازی، نگهداری | `telephony.settings.updated` |
| `GET /telephony/admin/sync-runs` | تاریخچه `telephony_sync_runs` | — |
| `GET /telephony/health` | برای همه کاربران واردشده: `{ available, ami, configApi, cdr }` فقط به‌صورت `ok/degraded/down` | — |

بدنه `PUT /telephony/admin/connections/ami`:

```json
{ "name": "AMI مرکزی", "host": "10.0.0.5", "port": 5039, "useTls": true, "tlsFingerprint": "AB:CD:...",
  "username": "kx_office", "secret": "<فقط هنگام تغییر>", "isActive": true,
  "settings": { "originateContext": "from-internal", "channelTech": "PJSIP" } }
```

اعتبارسنجی: `host` فقط IP یا نام میزبان شبکه خصوصی مجاز در `settings.allowedHosts` (جلوگیری از SSRF)؛ `secret` حداقل ۱۶ کاراکتر؛ هرگز در پاسخ یا لاگ برنمی‌گردد.

## ۲. داخلی‌ها

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/extensions` | `telephony.extensions.view` (دامنه واحد) | فیلترها: `q`، `unitId`، `syncStatus`، `lifecycle`، `unassigned=true`. خروجی هر ردیف: `id, extension, displayName, tech, lifecycle, syncStatus, deviceState, assignment{user, unit, position, validFrom}, lastSyncedAt, lastError` |
| `GET /telephony/extensions/:id` | همان | جزئیات + تاریخچه تخصیص + درخواست‌های تغییر |
| `POST /telephony/extensions/sync` | `telephony.extensions.request` | صف‌کردن `telephony.sync_extensions`؛ پاسخ ۲۰۲ `{ runId }` |
| `GET /telephony/extensions/suggestions` | `telephony.extensions.assign` | پیشنهاد تطبیق نام نمایشی با کاربر |
| `GET /telephony/presence?extensions=101,102` | `telephony.presence.view` | فقط `deviceState` |
| `GET /users/:id/extensions` | خود کاربر یا `telephony.extensions.view` | داخلی‌های فعال کاربر |

### تخصیص

| روش و مسیر | مجوز | بدنه / نتیجه |
|---|---|---|
| `POST /telephony/extensions/:id/assignments` | `telephony.extensions.assign` در واحد مقصد | `{ userId?, unitId, positionId?, isPrimary, validFrom?, note? }` → ۲۰۱. خطاها: ۴۰۹ `extension_already_assigned`، ۴۰۹ `user_has_primary_extension`، ۴۲۲ `position_unit_mismatch`، ۴۲۲ `extension_not_active` |
| `POST /telephony/assignments/:id/end` | `telephony.extensions.assign` | `{ reason }` → ۲۰۰ |
| `POST /telephony/extensions/:id/reassign` | `telephony.extensions.assign` | بستن تخصیص فعلی و ایجاد جدید در یک تراکنش |

### درخواست تغییر پیکربندی (فاز ۴؛ تا آن زمان این مسیرها وجود ندارند)

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/change-requests?status=` | `telephony.extensions.view` | فهرست |
| `POST /telephony/change-requests` | `telephony.extensions.request` | `{ op, extension, payload, reason }`؛ اگر `extension` در محدوده نیست ۴۲۲ `extension_out_of_range`؛ اگر درخواست باز دیگری هست ۴۰۹ `change_already_open` |
| `PATCH /telephony/change-requests/:id` | درخواست‌دهنده، فقط در `draft` | ویرایش |
| `POST /telephony/change-requests/:id/submit` | درخواست‌دهنده | `draft → pending_approval` |
| `POST /telephony/change-requests/:id/approve` | `telephony.extensions.approve` | ۴۰۳ `self_approval_forbidden` اگر خود درخواست‌دهنده باشد؛ صف‌کردن `telephony.apply_change` یا `manual_pending` |
| `POST /telephony/change-requests/:id/reject` | `telephony.extensions.approve` | `{ note }` الزامی |
| `POST /telephony/change-requests/:id/retry` | `telephony.extensions.approve` | فقط از `failed` |
| `POST /telephony/change-requests/:id/cancel` | درخواست‌دهنده یا تأییدکننده | فقط پیش از `applying` |
| `POST /telephony/change-requests/:id/confirm-manual` | `telephony.extensions.approve` | تأیید اعمال دستی پس از اینکه همگام‌سازی تغییر را دید؛ در غیر این صورت ۴۰۹ `pbx_change_not_observed` |

## ۳. تماس‌ها و تاریخچه

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/calls` | `telephony.calls.view_own` / `view_unit` / `view_all` | فیلترها: `from`، `to` (بازه)، `userId`، `unitId`، `direction`، `disposition`، `number`، `linked=true/false`، `entityType`+`entityId`. دامنه اعمال‌شده: فقط تماس‌های خود (`user_id` یا `call_parties`)، یا واحدهای مجاز (`unitsFor`)، یا همه. شماره بیرونی برای کاربر بدون `telephony.numbers.view_full` پوشانده می‌شود (`+98912***4567`) |
| `GET /telephony/calls/:id` | همان | جزئیات، طرف‌ها، پیوندها؛ رویدادهای خام فقط برای `telephony.settings.manage`. تماس نامرئی ۴۰۴ |
| `PATCH /telephony/calls/:id` | مشارکت‌کننده تماس یا `telephony.calls.annotate` | `{ note?, outcome? }` |
| `GET /telephony/calls/live` | `telephony.calls.view_own` به بالا | تماس‌های `state <> 'ended'` در دامنه کاربر |
| `GET /telephony/reports/summary` | `reports.view` + دامنه تماس | تجمیع بر اساس کارمند/واحد/روز/جهت/نتیجه؛ تعداد، مدت کل، میانگین انتظار، نرخ بی‌پاسخ |
| `GET /telephony/reports/export?format=xlsx` | همان | با `lib/xlsx.ts` (ایمن در برابر Formula Injection) |

### اتصال به پرونده

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `POST /telephony/calls/:id/links` | `telephony.calls.link` + دیدن تماس + دیدن موجودیت | `{ entityType, entityId, note? }`؛ ۴۰۴ اگر موجودیت برای کاربر نامرئی باشد (افشا نشود)؛ ۴۰۹ `duplicate` |
| `DELETE /telephony/calls/:id/links/:linkId` | ایجادکننده یا `telephony.calls.annotate` | — |
| `GET /letters/:id/calls` | دیدن نامه | تماس‌های پیوندشده به نامه، با اعمال دامنه تماس |
| `GET /archive/documents/:id/calls`، `GET /archive/folders/:id/calls` | دیدن موجودیت | همان الگو |
| `GET /contacts/:id/calls` | دیدن مخاطب | فقط پس از ساخت دفترچه مخاطبان |

### مخاطبان (آینده؛ خارج از فاز ۱)

`GET/POST /contacts`، `GET/PATCH /contacts/:id`، `POST /contacts/:id/phones`، `GET /contacts/lookup?number=` با مجوزهای `contacts.view` و `contacts.manage`. تا پیش از ساخت، `entityType='contact'` با ۴۲۲ `capability_not_supported` رد می‌شود.

### ضبط تماس (فقط اگر PBX ضبط داشته باشد و سازمان تصمیم بگیرد)

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/calls/:id/recordings` | `telephony.recordings.listen` + دیدن تماس | فقط فراداده |
| `GET /telephony/recordings/:id/stream` | `telephony.recordings.listen` + دیدن تماس | سرور فایل را از PBX می‌خواند و جریان می‌دهد؛ مسیر فایل در PBX هرگز به مرورگر داده نمی‌شود. هر پخش ممیزی می‌شود (`telephony.recording.played`) |
| `GET /telephony/recordings/:id/download` | `telephony.recordings.download` (جدا از شنیدن) + دیدن تماس | ممیزی `telephony.recording.downloaded` با دلیل الزامی در `?reason=` |

## ۴. تماس با یک کلیک

`POST /telephony/calls/originate` (مجوز `telephony.call`)

```json
{ "to": "02188001234", "fromExtensionId": "uuid اختیاری", "context": { "type": "letter", "id": "uuid" }, "idempotencyKey": "uuid" }
```

قواعد سمت سرور:

قواعد سمت سرور، به همین ترتیب (اولین شرط ناموفق، درخواست را رد می‌کند):

1. `fromExtensionId` باید یکی از داخلی‌های **فعال تخصیص‌یافته به خود کاربر** باشد (پیش‌فرض: داخلی اصلی). هیچ کاربری نمی‌تواند از داخلی دیگری تماس بگیرد. خطا: ۴۲۲ `no_extension_assigned` یا ۴۰۳ `extension_not_owned`.
2. `to` نرمال می‌شود (`services/telephony/numbers.ts`) و دسته آن از `telephony_number_classes` تعیین می‌شود.
3. اگر شماره یا پیشوند آن در `telephony_blocked_numbers` باشد: ۴۲۲ `blocked_number`.
4. سیاست مؤثر کاربر از `telephony_dial_policies` (اجتماع سیاست‌های فعال نقش‌ها و واحدهای کاربر؛ نبود سیاست = فقط داخلی). دسته شماره باید در `allowed_classes` باشد: ۴۲۲ `destination_not_allowed`. دسته‌های `international` و `premium` در هیچ سیاست پیش‌فرضی نیستند.
5. سقف ساعتی و روزانه سیاست (شمارش `click_to_call_requests` همان کاربر): ۴۲۹ `rate_limited`. بیش از یک درخواست هم‌زمان در حال زنگ: ۴۲۹ `concurrent_limit`. خارج از ساعت کاری در صورت `business_hours_only`: ۴۲۲ `outside_hours`.
6. اگر `context` داده شود، کاربر باید آن موجودیت را ببیند؛ پس از ایجاد تماس، پیوند `call_links` با `match_method='click_to_call'` خودکار ساخته می‌شود.
7. تکرار `idempotencyKey` همان پاسخ قبلی را برمی‌گرداند.
8. AMI `Originate` با `Async: true` و Timeout ۵ ثانیه؛ پاسخ ۲۰۲ `{ requestId, status: 'sent' }`. خطاها: ۵۰۳ `pbx_unavailable`، ۵۰۲ `pbx_rejected`.

**ثبت نتیجه:** هر درخواست، **چه پذیرفته چه ردشده**، یک ردیف در `click_to_call_requests` دارد (`status`، `reject_reason`، `pbx_response`، `number_class`، `dial_policy_id`). وضعیت پس از رویدادهای AMI و تطبیق CDR به `agent_no_answer`، `connected`، `failed` یا `completed` می‌رسد. این ثبت عملیاتی است و در `audit_logs` نوشته نمی‌شود (تصمیم D6). بیش از ۵ رد پیاپی `destination_not_allowed` یا `blocked_number` از یک کاربر در یک ساعت، اعلان `telephony.dial_abuse_suspected` به دارندگان `telephony.settings.manage` می‌فرستد.

### سیاست شماره‌گیری (`telephony.dial_policy.manage`)

| روش و مسیر | توضیح | ممیزی |
|---|---|---|
| `GET /telephony/admin/number-classes` و `PUT /telephony/admin/number-classes/:key` | دسته‌ها و الگوها | `telephony.number_class.updated` |
| `GET/POST /telephony/admin/dial-policies`، `PATCH/DELETE /telephony/admin/dial-policies/:id` | سیاست بر اساس نقش و واحد | `telephony.dial_policy.created/updated/deleted` |
| `GET/POST /telephony/admin/blocked-numbers`، `DELETE /telephony/admin/blocked-numbers/:number` | فهرست مسدود | `telephony.blocked_number.added/removed` |
| `GET /telephony/admin/call-operations?status=rejected` | گزارش درخواست‌های تماس ردشده و ناموفق | — |
| `GET /telephony/me/dial-policy` | (هر کاربر با `telephony.call`) دسته‌های مجاز و سهمیه باقی‌مانده خودش | — |

`GET /telephony/calls/originate/:requestId` وضعیت درخواست را برمی‌گرداند.

## ۵. رویداد لحظه‌ای (فاز تماس لحظه‌ای)

`GET /telephony/stream` (Server-Sent Events)

- `EventSource` امکان ارسال سرآیند `Authorization` ندارد. دو گزینه: (الف) خواندن جریان با `fetch` و `ReadableStream` در کلاینت با همان توکن؛ (ب) `POST /telephony/stream-ticket` یک بلیت یک‌بارمصرف ۳۰ ثانیه‌ای می‌دهد و `GET /telephony/stream?ticket=` آن را مصرف می‌کند. پیشنهاد: (الف)، چون توکن در URL و لاگ‌ها ظاهر نمی‌شود.
- رویدادها فقط در دامنه کاربر: `call.ringing`، `call.answered`، `call.ended`، `extension.state` (برای داخلی‌های خود و در صورت `telephony.presence.view` دیگران)، `originate.status`.
- Heartbeat هر ۲۵ ثانیه؛ با قطع، کلاینت به Polling `GET /telephony/calls/live` هر ۱۵ ثانیه برمی‌گردد.
- در چندنمونه‌ای، انتشار رویداد بین نمونه‌ها با `LISTEN/NOTIFY` پستگرس (بدون Broker جدید).

## ۶. کدهای خطای اختصاصی

| کد | HTTP | معنی |
|---|---|---|
| `telephony_disabled` | 503 | ماژول یا اتصال لازم غیرفعال است |
| `pbx_unavailable` | 503 | مرکز تلفن پاسخ نمی‌دهد |
| `pbx_rejected` | 502 | PBX درخواست را رد کرد (پیام خلاصه، بدون جزئیات حساس) |
| `pbx_conflict` | 409 | وضعیت داخلی در PBX از زمان درخواست تغییر کرده است |
| `pbx_change_not_observed` | 409 | تغییر دستی هنوز در PBX دیده نشده |
| `capability_not_supported` | 422 | آداپتور پیکربندی این عمل را پشتیبانی نمی‌کند |
| `extension_already_assigned` | 409 | — |
| `user_has_primary_extension` | 409 | — |
| `position_unit_mismatch` | 422 | — |
| `extension_out_of_range` | 422 | — |
| `extension_not_active` | 422 | — |
| `change_already_open` | 409 | — |
| `self_approval_forbidden` | 403 | — |
| `no_extension_assigned` | 422 | — |
| `extension_not_owned` | 403 | — |
| `destination_not_allowed` | 422 | — |
| `blocked_number` | 422 | — |
| `rate_limited` | 429 | — |
| `concurrent_limit` | 429 | — |
| `outside_hours` | 422 | — |

## ۷. مسیرهای ممنوع

هیچ مسیری پراکسی خام به AMI، ARI، API مدیریتی Issabel یا پایگاه CDR ارائه نمی‌دهد (مثلاً «اجرای دستور AMI دلخواه» یا «پرس‌وجوی SQL روی CDR»). همه عملیات‌ها نام‌دار و اعتبارسنجی‌شده‌اند.

## ۸. OpenAPI

پس از پیاده‌سازی، مسیرها به `apps/office-api/openapi.yaml` با `scripts/gen-openapi.py` افزوده می‌شوند.
