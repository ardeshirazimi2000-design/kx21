# ۲. مدل داده

پایگاه داده اتوماسیون (`kx_office`) از پایگاه داده سامانه جلسات (`kx`) جداست؛ ارتباط دو سامانه فقط از راه API و Webhook است. اسکیما در `apps/office-api/src/db/migrations/001_init.sql` تعریف شده است.

| گروه | جدول‌ها |
|---|---|
| سازمان و کاربران | `org_units` (درخت واحدها)، `positions` (سمت، با مدیر واحد)، `users` (سطح طبقه‌بندی، TOTP رمزنگاری‌شده)، `user_positions`، `refresh_tokens` (خانواده توکن برای تشخیص استفاده مجدد)، `user_external_links` (تطبیق کاربر با کاربر سامانه جلسات) |
| دسترسی | `roles`، `permissions`، `role_permissions`، `user_roles` (با `scope_unit_id` اختیاری) |
| مکاتبات | `letter_templates` (سربرگ: لوگو یا اسکن کامل سربرگ، حاشیه‌ها، پاورقی، متن آغازین، پیش‌فرض)، `number_sequences` (شمارنده سالانه بدون شکاف)، `letters` (شماره، کد رهگیری، طبقه‌بندی، اولویت، ستون `search` از نوع tsvector با ایندکس GIN، `content_hash`)، `letter_recipients`، `letter_attachments` (گروه نسخه، هش SHA-256، کلید فایل رمزنگاری‌شده)، `letter_routing` (ارجاعات کارتابل با مهلت) |
| گردش کار | `workflow_definitions` (کلید + نسخه، تعریف JSON)، `workflow_instances` (موضوع: نامه، مصوبه یا سند؛ متغیرهای متن)، `workflow_steps` (مسئول، مهلت، یادآوری، ارتقا، اقدام) |
| بایگانی | `retention_policies`، `archive_folders` (درختی، با ارث سیاست نگهداری)، `documents` (توقیف قانونی، امحا)، `document_versions`، `signatures` (Ed25519 روی هش، همراه تصویر نمونه امضای لحظه امضا) |
| اعلان و صف | `notification_templates`، `notifications`، `jobs` (صف پایدار با `run_at`، تلاش‌ها و قفل) |
| یکپارچگی | `integrations` (نوع، آدرس، اسرار رمزنگاری‌شده، نگاشت‌ها)، `integration_inbox` (رویدادهای دریافتی با کلید یکتای `event_id`)، `meetings_cache` و `resolutions_cache` (نسخه محلی جلسات و مصوبات)، `resolution_feedback` (بازخوردهای ارسالی و وضعیت تحویل)، `letter_meeting_refs` (ارجاع نامه به کمیسیون/جلسه)، `meeting_invitation_letters` (نامه دعوت هر مدعو جلسه) |
| ممیزی | `audit_logs` (هر ردیف هش ردیف قبلی را دارد؛ تریگر پایگاه داده UPDATE و DELETE را رد می‌کند) |

نکات:

- همه کلیدها UUID هستند و زمان‌ها `timestamptz`؛ نمایش شمسی در لایه رابط انجام می‌شود.
- تابع `fa_normalize` در پایگاه داده ی و ک عربی، ارقام فارسی و عربی و نیم‌فاصله را یکسان می‌کند؛ هم متن ذخیره‌شده و هم عبارت جستجو با آن نرمال می‌شوند.
- فایل‌ها در `STORAGE_DIR` با AES-256-GCM و کلید `DATA_ENCRYPTION_KEY` ذخیره می‌شوند؛ هش محتوای اصلی برای یکپارچگی و امضا نگه داشته می‌شود.
- نمونه امضای کاربر در ستون‌های `users.signature_key` و `signature_mime` (فایل رمزنگاری‌شده) نگه داشته می‌شود (مهاجرت `002_invitations_signatures.sql`).
- متن نامه صادره و داخلی HTML ویرایشگر است (`letters.body_format = 'html'`) که سرور فقط زیرمجموعه مجاز آن را نگه می‌دارد؛ جستجو برچسب‌های HTML را نادیده می‌گیرد. `letters.template_id` سربرگ و `letters.signatory_id` امضاکننده تعیین‌شده است (مهاجرت `003_letter_templates.sql`).
- امضای نامه هش متن، مشخصات، قالب و پیوست‌ها را پوشش می‌دهد. از `signatures.hash_version = 2` شماره اندیکاتور در هش نیست تا نامه پیش از شماره شدن امضا شود؛ امضاهای قدیمی (نسخه ۱) همچنان با هش نسخه خودشان بررسی می‌شوند.
- صحت زنجیره ممیزی از `GET /api/audit/verify` قابل بررسی است.
