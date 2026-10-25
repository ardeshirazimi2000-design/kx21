# چرخه حیات تماس

> نام رویدادهای AMI بر اساس Asterisk 12 به بالا است (`DialBegin`، `DialEnd`، `BridgeEnter`، `Hangup`، `Cdr`، `DeviceStateChange`). نسخه Asterisk نصب‌شده **نامشخص** است؛ اگر قدیمی‌تر باشد (مثلاً ۱۱)، نام‌ها (`Dial`، `Bridge`) فرق می‌کند و نگاشت در آداپتور تغییر می‌کند، نه در دامنه.

## ۱. شناسه‌ها و همبستگی

- هر کانال یک `Uniqueid` دارد؛ همه کانال‌های یک تماس منطقی یک `Linkedid` مشترک دارند. ردیف `calls` با `(pbx_key, pbx_linkedid)` یکتا است.
- تماس با یک کلیک: `ActionID` و متغیر کانال `KX_C2C=<request id>` در `Originate`؛ شنونده با دیدن این متغیر (`VarSet` یا `Newchannel` + `Getvar` در صورت نیاز) درخواست را به `calls` وصل می‌کند.
- CDR: ستون `linkedid` (در صورت وجود در جدول CDR نسخه نصب‌شده؛ **نامشخص**) یا `uniqueid` برای تطبیق با `calls`.

## ۲. تعیین جهت و طرف سازمان

| شرط | جهت |
|---|---|
| کانال اول از Trunk (نام کانال با پیشوند Trunkهای `settings.trunks`) و مقصد داخلی/صف/IVR | `inbound` |
| کانال اول از داخلی و مقصد از Trunk | `outbound` |
| هر دو طرف داخلی | `internal` |
| هیچ‌کدام قابل تشخیص نیست | `unknown` (برای بازبینی) |

`extension_id`، `user_id` و `unit_id` از **تخصیص فعال در لحظه شروع تماس** (`extension_assignments` با `valid_from <= started_at < coalesce(valid_to, ∞)`) گرفته و ذخیره (Snapshot) می‌شوند تا جابه‌جایی بعدی کارمند، گزارش گذشته را تغییر ندهد.

## ۳. تماس ورودی

```mermaid
sequenceDiagram
  autonumber
  participant T as Trunk / تماس‌گیرنده
  participant PBX as Asterisk
  participant L as شنونده AMI
  participant DB as kx_office
  participant UI as مرورگر کارمند
  T->>PBX: INVITE
  PBX-->>L: Newchannel (Linkedid=L1, CallerIDNum)
  L->>DB: UPSERT calls(L1, inbound, state=ringing, external_number)
  PBX-->>L: DialBegin (Dest=PJSIP/101)
  L->>DB: call_parties(101, ringing) ؛ تطبیق شماره (با contacts در آینده)
  L-->>UI: SSE call.ringing (نام مخاطب اگر مجاز)
  PBX-->>L: DialEnd (DialStatus=ANSWER) / BridgeEnter
  L->>DB: state=answered, answered_at, extension_id=101, user_id/unit_id snapshot
  L-->>UI: SSE call.answered
  T->>PBX: BYE
  PBX-->>L: Hangup (Cause)
  L->>DB: state=ended, ended_at, disposition
  L-->>UI: SSE call.ended (پیشنهاد «اتصال به پرونده»)
  Note over DB: کار telephony.pull_cdr بعداً CDR را می‌خواند و talk_seconds و disposition را نهایی می‌کند
```

- صف یا زنگ گروهی: هر `DialBegin` به یک داخلی یک ردیف `call_parties` با نقش `ringing` یا `queue_member`؛ پاسخ‌دهنده `answered=true` و `calls.extension_id` می‌شود.
- تماس بی‌پاسخ: `Hangup` بدون `BridgeEnter` → `disposition='no_answer'` یا `busy` بر اساس `DialStatus`. اعلان اختیاری `telephony.missed_call` به داخلی‌های زنگ‌خورده.
- انتقال (Transfer): رویدادهای `BlindTransfer`/`AttendedTransfer` → `call_parties` با نقش `transfer_target`؛ `calls.extension_id` به آخرین پاسخ‌دهنده تغییر می‌کند و اولی در `call_parties` می‌ماند.

## ۴. تماس خروجی (از تلفن کارمند)

مانند ورودی، با این تفاوت که کانال اول داخلی است و `Newchannel` با `Exten` شماره مقصد. `external_number` از `DialBegin.DestCallerIDNum` یا `Exten` نرمال می‌شود.

## ۵. تماس با یک کلیک

```mermaid
sequenceDiagram
  autonumber
  participant UI as مرورگر
  participant API as office-api
  participant DB as kx_office
  participant AMI as Asterisk AMI
  participant P as تلفن کارمند (101)
  participant X as مقصد بیرونی
  UI->>API: POST /telephony/calls/originate {to, context, idempotencyKey}
  API->>DB: بررسی مجوز، مالکیت داخلی، فهرست مسدود، سیاست شماره‌گیری، سقف‌ها
  API->>DB: INSERT click_to_call_requests(status=requested یا rejected + reject_reason) ؛ بدون audit_logs
  Note over API,AMI: قالب Channel و Context نمونه است و به درایور و dialplan واقعی بستگی دارد (نامشخص)
  API->>AMI: Originate Channel=PJSIP/101 Context=from-internal Exten=<to> Async=true ActionID=c2c-<id> Variable=KX_C2C=<id>
  AMI-->>API: Response: Success (پذیرفته شد)
  API-->>UI: 202 {requestId, status: sent}
  AMI->>P: زنگ تلفن کارمند
  P-->>AMI: برداشتن گوشی
  AMI->>X: شماره‌گیری مقصد
  AMI-->>API: OriginateResponse (Success/Failure) ؛ رویدادهای Newchannel/DialBegin/BridgeEnter
  API->>DB: request.status=connected، ساخت calls (source=click_to_call) و call_links به context
  API-->>UI: SSE originate.status / call.answered
```

- هر مرحله وضعیت همان ردیف `click_to_call_requests` را جلو می‌برد (`sent` → `agent_ringing` → `connected` → `completed`) تا نتیجه هر عملیات قابل گزارش باشد.
- اگر کارمند گوشی را برندارد: `OriginateResponse` با `Reason` ۳ یا ۵ → `failed` با `error_code='agent_no_answer'`؛ تماسی به بیرون زده نمی‌شود.
- `Context` و قالب `Channel` (`PJSIP/` یا `SIP/`) از تنظیمات اتصال خوانده می‌شود و **باید با مدیر مرکز تلفن تأیید شود** تا مسیریابی و محدودیت‌های تماس بیرونی Issabel (Outbound Routes) دور زده نشوند. Originate همیشه به Context عادی داخلی‌ها می‌رود تا همان قوانین مسیریابی و دسترسی اعمال شوند.

## ۶. قطع تماس و ثبت تاریخچه

1. `Hangup` آخرین کانال یک `Linkedid` → `state='ended'`، `ended_at`، محاسبه موقت `ring_seconds` و `talk_seconds`.
2. کار دوره‌ای `telephony.pull_cdr` (پیش‌فرض هر ۲ دقیقه) ردیف‌های جدید CDR را از مکان‌نما می‌خواند (مکان‌نما: `calldate` + `sequence`/`uniqueid` در `integrations.state`، با هم‌پوشانی ۵ دقیقه‌ای برای ردیف‌های دیر نوشته‌شده)، در `cdr_records` با `ON CONFLICT DO NOTHING` درج و با `calls` تطبیق می‌دهد:
   - تماس موجود: `talk_seconds` و `disposition` از CDR نهایی و `cdr_reconciled=true`.
   - تماس بدون ردیف (شنونده قطع بوده): ایجاد `calls` با `source='cdr'`.
3. تماس‌هایی که بیش از `settings.staleLiveMinutes` (پیش‌فرض ۱۲۰ دقیقه) `ended` نشده‌اند و CDR آن‌ها آمده، بسته می‌شوند؛ اگر CDR هم نیامده، `ended` با `disposition=NULL` و علامت بازبینی.
4. پس از پایان، UI پیشنهاد اتصال به پرونده را نشان می‌دهد: نامه‌ها و مخاطبانی که شماره آن‌ها با `external_number` منطبق است (فقط موارد قابل دیدن برای کاربر).

## ۷. تطبیق خودکار با مخاطب

> این بخش فقط پس از ساخت دفترچه مخاطبان فعال می‌شود (تصمیم D5). تا آن زمان `resolveNumber` فقط شماره‌های داخلی را به کارمند تطبیق می‌دهد و پیشنهاد پیوند فقط از نامه‌ها و اسنادی است که کاربر می‌بیند.

- نرمال‌سازی شماره (`numbers.ts`): حذف فاصله و خط تیره، ارقام فارسی به لاتین (مانند `fa_normalize`)، `0098`/`98`/`0` به `+98`، شماره ثابت بدون پیش‌شماره با `settings.defaultAreaCode` (مثلاً تهران `21`).
- `contact_phones.number = calls.external_number` → پیوند `match_method='auto_number'` فقط اگر **یک** مخاطب منطبق باشد؛ در غیر این صورت فقط پیشنهاد.
- شماره‌های مخفی (`anonymous`، خالی) هرگز تطبیق نمی‌شوند.

## ۸. موارد مرزی

| مورد | رفتار |
|---|---|
| رویداد تکراری پس از اتصال مجدد AMI | `call_events` یکتا روی `(pbx_uniqueid, event_type, seq)`؛ UPSERT `calls` ناهمگام‌پذیر (فقط پیشروی وضعیت: `ringing → answered → ended`، هرگز برگشت) |
| ترتیب نادرست رویدادها | زمان رویداد از `Timestamp` AMI (در صورت فعال بودن `timestampevents`) و نه زمان دریافت |
| قطع شنونده در وسط تماس | CDR بعداً تماس را تکمیل می‌کند (بند ۶) |
| داخلی بدون تخصیص | `user_id` و `unit_id` خالی؛ در گزارش «بدون تخصیص» |
| تماس داخلی بین دو کارمند | یک ردیف `calls` با `direction='internal'` و هر دو در `call_parties`؛ هر دو آن را در «تماس‌های من» می‌بینند |
| تغییر ساعت سرورها | هشدار در `GET /telephony/health` اگر اختلاف ساعت PBX و سرور اتوماسیون بیش از ۳۰ ثانیه باشد (از `Timestamp` رویدادها) |
