# ۳. API و رویدادهای زنده

- مستند کامل OpenAPI 3.1: [`apps/api/openapi.yaml`](../apps/api/openapi.yaml) (روی سرور: `GET /api/openapi.yaml`، قابل بارگذاری در Swagger UI/Redoc). تولید مجدد: `python3 apps/api/scripts/gen-openapi.py apps/api/openapi.yaml`.
- احراز هویت: `Authorization: Bearer <accessToken>`؛ تمدید با `POST /api/auth/refresh`.
- قالب خطا: `{ "error": { "code", "message", "details?" } }` با پیام فارسی. کدهای مهم: `checkin_closed`، `quorum_not_reached`، `vote_open`، `vote_closed`، `already_voted`، `item_not_active`، `invalid_transition`، `position_taken`، `minutes_locked`.
- فهرست‌ها: `?page&pageSize&q` ⇒ `{ items, total, page, pageSize }`.

همه APIهای پیشنهادی بخش ۱۱ سند پیاده‌سازی شده‌اند (۹۶ عملیات). علاوه بر آن‌ها:
ایجاد/ویرایش مدعوین، بستن اعلام حضور، لغو و بایگانی جلسه، ترتیب دستور جلسه، خاتمه آیتم با ارجاع کارشناسی، اصلاح رسمی رأی، نسخه‌های صورتجلسه، بررسی مصوبه، مسائل و ارجاعات، اسناد، اعلان‌ها، داشبورد اتاق، گزارش حضور، جستجوی سراسری، Audit و بررسی زنجیره هش.

## رویدادهای Socket.IO

اتصال: `io(API_URL, { auth: { token } })`، سپس `emit('meeting:join', meetingId)`.

| رویداد | گیرنده | محتوا |
|---|---|---|
| `meeting.updated` | جلسه | تغییر وضعیت/زمان |
| `attendance.updated` | افسران جلسه | لیست کامل حضور + جزئیات نصاب |
| `quorum.updated` | همه | `{eligible, present, required, reached, attendingTotal}` |
| `agenda.updated` | همه | وضعیت آیتم‌ها |
| `comment.created` | همه | نظر جدید |
| `vote.opened` / `vote.progress` / `vote.closed` | همه | شروع، تعداد آرا (بدون محتوا)، نتیجه طبق مجوز |
| `notification` | شخص | اعلان داخل برنامه |
