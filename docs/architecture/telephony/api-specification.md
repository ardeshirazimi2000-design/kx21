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

## ۱. اتصال و تنظیمات (`telephony.manage`)

| روش و مسیر | توضیح | ممیزی |
|---|---|---|
| `GET /telephony/admin/connections` | فهرست اتصال‌ها؛ به‌جای `secret_enc` فقط `hasSecret: boolean` | — |
| `PUT /telephony/admin/connections/:purpose` | ایجاد/به‌روزرسانی اتصال `config_api`، `ami` یا `cdr_db` | `telephony.connection.updated` (بدون راز؛ فقط `secretChanged: true`) |
| `POST /telephony/admin/connections/:purpose/test` | آزمون اتصال با Timeout ۱۰ ثانیه؛ برای AMI فقط Login و `Ping`؛ برای API فقط خواندن نسخه؛ برای CDR فقط `SELECT 1` و شمارش | `telephony.connection.tested` |
| `GET /telephony/admin/capabilities` | خروجی `PbxConfigAdapter.capabilities()` و نسخه‌ها و رابط‌های کشف‌شده (نسخه Issabel/Asterisk، درایور، وجود API مدیریتی، ستون‌های CDR)؛ مبنای تصمیم درباره فاز ۴ | — |
| `PUT /telephony/admin/settings` | محدوده داخلی‌ها، پیش‌شماره‌ها، الگوی مقصد مجاز، فواصل همگام‌سازی، نگهداری | `telephony.settings.updated` |
| `GET /telephony/admin/sync-runs` | تاریخچه `telephony_sync_runs` | — |
| `GET /telephony/health` | برای همه کاربران واردشده: `{ available, ami, configApi, cdr, recordings }`؛ چهار مورد اول `ok/degraded/down/disabled` و `recordings` تا تأیید C7 همیشه `disabled` | — |

بدنه `PUT /telephony/admin/connections/ami`:

```json
{ "name": "AMI مرکزی", "host": "10.0.0.5", "port": 5039, "useTls": true, "tlsFingerprint": "AB:CD:...",
  "username": "kx_office", "secret": "<فقط هنگام تغییر>", "isActive": true,
  "settings": { "originateContext": "from-internal", "channelTech": "PJSIP" } }
```

مقادیر بالا فقط نمونه‌اند؛ میزبان، پورت، Context و درایور واقعی **نیازمند تأیید** هستند (B1، A3، E4). در فاز ۱ و ۲ آزمون هر اتصال فقط عملیات خواندنی انجام می‌دهد و `originateContext` استفاده نمی‌شود.

اعتبارسنجی: `host` فقط IP یا نام میزبان شبکه خصوصی مجاز در `settings.allowedHosts` (جلوگیری از SSRF)؛ `secret` حداقل ۱۶ کاراکتر؛ هرگز در پاسخ یا لاگ برنمی‌گردد.

## ۲. داخلی‌ها

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/extensions` | `extension.view` (دامنه واحد) | فیلترها: `q`، `unitId`، `syncStatus`، `lifecycle`، `unassigned=true`. خروجی هر ردیف: `id, extension, displayName, tech, lifecycle, syncStatus, deviceState, assignment{user, unit, position, validFrom}, lastSyncedAt, lastError` |
| `GET /telephony/extensions/:id` | همان | جزئیات + تاریخچه تخصیص + درخواست‌های تغییر |
| `POST /telephony/extensions/sync` | `extension.assign` یا `telephony.manage` | صف‌کردن `telephony.sync_extensions`؛ پاسخ ۲۰۲ `{ runId }` |
| `GET /telephony/extensions/suggestions` | `extension.assign` | پیشنهاد تطبیق نام نمایشی با کاربر |
| `GET /telephony/presence?extensions=101,102` | `presence.view` (فاز ۳) | فقط `deviceState`؛ در فاز ۱ و ۲ ستون `deviceState` فهرست داخلی‌ها همیشه `unknown` است |
| `GET /users/:id/extensions` | خود کاربر یا `extension.view` | داخلی‌های فعال کاربر |

### تخصیص

| روش و مسیر | مجوز | بدنه / نتیجه |
|---|---|---|
| `POST /telephony/extensions/:id/assignments` | `extension.assign` در واحد مقصد | `{ userId?, unitId, positionId?, isPrimary, validFrom?, note? }` → ۲۰۱. خطاها: ۴۰۹ `extension_already_assigned`، ۴۰۹ `user_has_primary_extension`، ۴۲۲ `position_unit_mismatch`، ۴۲۲ `extension_not_active` |
| `POST /telephony/assignments/:id/end` | `extension.assign` | `{ reason }` → ۲۰۰ |
| `POST /telephony/extensions/:id/reassign` | `extension.assign` | بستن تخصیص فعلی و ایجاد جدید در یک تراکنش |

### درخواست تغییر پیکربندی (فاز ۴؛ تا آن زمان این مسیرها وجود ندارند)

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/change-requests?status=` | `extension.view` | فهرست |
| `POST /telephony/change-requests` | بر اساس `op`: `extension.create`، `extension.update` یا `extension.disable` (و برای `enable` همان `extension.disable`) | `{ op, extension, payload, reason }`؛ `op='delete'` در فاز ۴ پشتیبانی نمی‌شود (۴۲۲ `capability_not_supported`)؛ اگر `extension` در محدوده نیست ۴۲۲ `extension_out_of_range`؛ اگر درخواست باز دیگری هست ۴۰۹ `change_already_open` |
| `PATCH /telephony/change-requests/:id` | درخواست‌دهنده، فقط در `draft` | ویرایش |
| `POST /telephony/change-requests/:id/submit` | درخواست‌دهنده | `draft → pending_approval` |
| `POST /telephony/change-requests/:id/approve` | `extension.approve` | ۴۰۳ `self_approval_forbidden` اگر خود درخواست‌دهنده باشد؛ صف‌کردن `telephony.apply_change` یا `manual_pending` |
| `POST /telephony/change-requests/:id/reject` | `extension.approve` | `{ note }` الزامی |
| `POST /telephony/change-requests/:id/retry` | `extension.approve` | فقط از `failed` |
| `POST /telephony/change-requests/:id/cancel` | درخواست‌دهنده یا تأییدکننده | فقط پیش از `applying` |
| `POST /telephony/change-requests/:id/confirm-manual` | `extension.approve` | تأیید اعمال دستی پس از اینکه همگام‌سازی تغییر را دید؛ در غیر این صورت ۴۰۹ `pbx_change_not_observed` |

## ۳. تماس‌ها و تاریخچه

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/calls` | `call.read`؛ دامنه بیشتر با `call.read_unit` یا `call.read_all` | فیلترها: `from`، `to` (بازه)، `userId`، `unitId`، `direction`، `disposition`، `completeness`، `number`، `linked=true/false`، `entityType`+`entityId`. دامنه همیشه با `callVisibleSql` اعمال می‌شود (`security-and-audit.md` بخش ۳)؛ فیلتر `userId` یا `unitId` خارج از دامنه، نتیجه خالی می‌دهد نه خطا. شماره بیرونی برای کاربر بدون `call.number_full` پوشانده می‌شود (`+98912***4567`) |
| `GET /telephony/calls/:id` | همان | جزئیات، بخش‌ها، طرف‌ها، پیوندها؛ رویدادهای خام فقط برای کسی که **هم** `telephony.manage` دارد **و هم** تماس را با `callVisibleSql` می‌بیند (مجوز فنی به‌تنهایی دسترسی به تاریخچه نمی‌دهد). تماس نامرئی ۴۰۴ |
| `PATCH /telephony/calls/:id` | مشارکت‌کننده تماس یا `call.annotate` | `{ note?, outcome? }` |
| `GET /telephony/calls/live` | `call.read` به بالا | تماس‌های `state <> 'ended'` در دامنه کاربر |
| `GET /telephony/reports/summary` | `reports.view` + `call.read` و دامنه `callVisibleSql` | تجمیع بر اساس کارمند/واحد/روز/جهت/نتیجه؛ تعداد، مدت کل، میانگین انتظار، نرخ بی‌پاسخ |
| `GET /telephony/reports/export?format=xlsx` | `call.export` + دامنه `callVisibleSql` | با `lib/xlsx.ts` (ایمن در برابر Formula Injection)؛ پوشاندن شماره مانند API؛ ممیزی `telephony.calls.exported` |

### اتصال به پرونده

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `POST /telephony/calls/:id/links` | `call.link` + دیدن تماس + دیدن موجودیت | `{ entityType, entityId, note? }`؛ ۴۰۴ اگر موجودیت برای کاربر نامرئی باشد (افشا نشود)؛ ۴۰۹ `duplicate` |
| `DELETE /telephony/calls/:id/links/:linkId` | ایجادکننده یا `call.annotate` | — |
| `GET /letters/:id/calls` | دیدن نامه | تماس‌های پیوندشده به نامه، با اعمال دامنه تماس |
| `GET /archive/documents/:id/calls`، `GET /archive/folders/:id/calls` | دیدن موجودیت | همان الگو |
| `GET /contacts/:id/calls` | دیدن مخاطب | آینده؛ در فازهای ۱ تا ۵ وجود ندارد |

### مخاطبان (آینده؛ خارج از فاز ۱)

فقط برای پیش‌بینی معماری؛ در فازهای ۱ تا ۵ پیاده نمی‌شوند: `GET/POST /contacts`، `GET/PATCH /contacts/:id`، `POST /contacts/:id/phones`، `GET /contacts/lookup?number=` با مجوزهای `contacts.view` و `contacts.manage`. تا پیش از ساخت، `entityType='contact'` با ۴۲۲ `capability_not_supported` رد می‌شود.

### ضبط تماس (غیرفعال؛ فقط اگر PBX ضبط داشته باشد و سازمان تصمیم بگیرد)

تا تأیید C7 و F11 این مسیرها ثبت نمی‌شوند و درخواست به آن‌ها ۴۰۴ می‌گیرد؛ `GET /telephony/health` مقدار `recordings: "disabled"` برمی‌گرداند.

| روش و مسیر | مجوز | توضیح |
|---|---|---|
| `GET /telephony/calls/:id/recordings` | `call.recording_listen` + دیدن تماس | فقط فراداده |
| `GET /telephony/recordings/:id/stream` | `call.recording_listen` + دیدن تماس | سرور فایل را از PBX می‌خواند و جریان می‌دهد؛ مسیر فایل در PBX هرگز به مرورگر داده نمی‌شود. هر پخش ممیزی می‌شود (`telephony.recording.played`) |
| `POST /telephony/recordings/:id/download` | `call.recording_download` (جدا از شنیدن) + دیدن تماس | بدنه `{ reason }` الزامی (در بدنه، نه URL، تا در لاگ دسترسی ثبت نشود)؛ ممیزی `telephony.recording.downloaded` |

## ۴. تماس با یک کلیک

`POST /telephony/calls/originate` (مجوز `call.originate`)

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

**ثبت نتیجه:** هر درخواست، **چه پذیرفته چه ردشده**، یک ردیف در `click_to_call_requests` دارد (`status`، `reject_reason`، `pbx_response`، `number_class`، `dial_policy_id`). وضعیت پس از رویدادهای AMI و تطبیق CDR به `agent_no_answer`، `connected`، `failed` یا `completed` می‌رسد. این ثبت عملیاتی است و در `audit_logs` نوشته نمی‌شود (تصمیم D6). بیش از ۵ رد پیاپی `destination_not_allowed` یا `blocked_number` از یک کاربر در یک ساعت، اعلان `telephony.dial_abuse_suspected` به دارندگان `telephony.manage` می‌فرستد.

### سیاست شماره‌گیری (`dialing.manage`)

| روش و مسیر | توضیح | ممیزی |
|---|---|---|
| `GET /telephony/admin/number-classes` و `PUT /telephony/admin/number-classes/:key` | دسته‌ها و الگوها | `telephony.number_class.updated` |
| `GET/POST /telephony/admin/dial-policies`، `PATCH/DELETE /telephony/admin/dial-policies/:id` | سیاست بر اساس نقش و واحد | `telephony.dial_policy.created/updated/deleted` |
| `GET/POST /telephony/admin/blocked-numbers`، `DELETE /telephony/admin/blocked-numbers/:number` | فهرست مسدود | `telephony.blocked_number.added/removed` |
| `GET /telephony/admin/call-operations?status=rejected` | گزارش درخواست‌های تماس ردشده و ناموفق برای پایش سوءاستفاده: کاربر، زمان، دلیل، دسته شماره؛ شماره مقصد پوشانده مگر با `call.number_full` | — |
| `GET /telephony/me/dial-policy` | (هر کاربر با `call.originate`) دسته‌های مجاز و سهمیه باقی‌مانده خودش | — |

`GET /telephony/calls/originate/:requestId` وضعیت درخواست را برمی‌گرداند.

## ۵. رویداد لحظه‌ای (فاز ۳)

`GET /telephony/stream` (Server-Sent Events). طراحی امنیتی کامل در `security-and-audit.md` بخش ۹.۲؛ خلاصه:

- پشت `authenticate` با سرآیند `Authorization`؛ کلاینت با `fetch` و `ReadableStream` می‌خواند، نه `EventSource`.
- مجوز: `call.read` برای رویدادهای تماس و `presence.view` برای وضعیت داخلی همکاران. هر رویداد پیش از ارسال با قاعده `callVisibleSql` برای همان کاربر سنجیده می‌شود.
- رویدادها: `call.ringing`، `call.answered`، `call.ended`، `extension.state`، `originate.status` با محتوای حداقلی (شناسه، وضعیت، داخلی، زمان، شماره پوشانده).
- جریان در انقضای توکن دسترسی بسته می‌شود؛ رویداد گذشته بازپخش نمی‌شود و کلاینت پس از اتصال مجدد از `GET /telephony/calls/live` وضعیت را می‌گیرد.
- SSE فقط کانال تحویل است؛ هر داده آن از API هم با همان قاعده قابل دریافت است و هیچ عملی از طریق آن انجام نمی‌شود.

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
| `sensitive_grant_forbidden` | 403 | افزودن مجوز حساس بدون `roles.grant_sensitive` یا اعطا به خود (پیشنهادی برای `routes/org.ts`) |
| `destination_not_allowed` | 422 | — |
| `blocked_number` | 422 | — |
| `rate_limited` | 429 | — |
| `concurrent_limit` | 429 | — |
| `outside_hours` | 422 | — |

## ۷. مسیرهای ممنوع

هیچ مسیری پراکسی خام به AMI، ARI، API مدیریتی Issabel یا پایگاه CDR ارائه نمی‌دهد (مثلاً «اجرای دستور AMI دلخواه» یا «پرس‌وجوی SQL روی CDR»). همه عملیات‌ها نام‌دار و اعتبارسنجی‌شده‌اند.

## ۸. OpenAPI

پس از پیاده‌سازی، مسیرها به `apps/office-api/openapi.yaml` با `scripts/gen-openapi.py` افزوده می‌شوند.

## ۹. ردیابی مجوزها به مسیرها

| مجوز | مسیرها | حساس |
|---|---|:-:|
| `telephony.manage` | `/telephony/admin/connections*`، `/telephony/admin/settings`، `/telephony/admin/capabilities`، `/telephony/admin/sync-runs`، `POST /telephony/extensions/sync` | |
| `extension.view` | `GET /telephony/extensions*`، `GET /users/:id/extensions`، `GET /telephony/change-requests` | |
| `extension.assign` | `POST /telephony/extensions/:id/assignments`، `/assignments/:id/end`، `/extensions/:id/reassign`، `/extensions/suggestions`، `POST /telephony/extensions/sync` | |
| `extension.create` / `.update` / `.disable` | `POST /telephony/change-requests` (بر اساس `op`) | |
| `extension.approve` | `/change-requests/:id/approve`، `reject`، `retry`، `confirm-manual` | |
| `extension.provision` | نمایش یک‌باره اطلاعات راه‌اندازی پس از `applied` | |
| `call.read` | `GET /telephony/calls*`، `/calls/live`، `/reports/summary`، `GET /letters/:id/calls` و مشابه، SSE | |
| `call.read_unit` | همان مسیرها با دامنه واحد | |
| `call.read_all` | همان مسیرها بدون محدودیت دامنه | ✓ |
| `call.link` | `POST/DELETE /telephony/calls/:id/links` | |
| `call.annotate` | `PATCH /telephony/calls/:id` (تماس دیگران)، حذف پیوند دیگران | |
| `call.export` | `GET /telephony/reports/export` | |
| `call.number_full` | همه مسیرها و SSE: شماره کامل به‌جای پوشانده | |
| `call.originate` | `POST /telephony/calls/originate`، `GET /telephony/calls/originate/:requestId`، `GET /telephony/me/dial-policy` | |
| `dialing.manage` | `/telephony/admin/number-classes*`، `/dial-policies*`، `/blocked-numbers*`، `/call-operations` | |
| `presence.view` | `GET /telephony/presence`، رویداد `extension.state` همکاران در SSE | |
| `call.recording_listen` | `GET /telephony/calls/:id/recordings`، `GET /telephony/recordings/:id/stream` | ✓ |
| `call.recording_download` | `POST /telephony/recordings/:id/download` | ✓ |
| `queues.view` / `queues.manage` | مسیرهای فاز ۵ (پس از تأیید رابط واقعی تعریف می‌شوند) | |
| `roles.grant_sensitive` | `POST/PATCH /roles` و `POST/PATCH /users` وقتی مجوز حساس در کار است (پیشنهادی) | ✓ |
