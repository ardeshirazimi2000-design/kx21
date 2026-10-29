# سامانه اتوماسیون اداری

سامانه اتوماسیون اداری اتاق، بر اساس سند «معماری سامانه اتوماسیون اداری» ساخته شده و با سامانه جلسات کمیسیون‌ها (همین مخزن، `apps/api` و `apps/web`) به‌صورت دوطرفه یکپارچه است.

| بخش | مسیر | توضیح |
|---|---|---|
| API اتوماسیون | `apps/office-api` | Node 22، Express 5، TypeScript، PostgreSQL 16 (پایگاه داده جدا: `kx_office`) |
| وب اتوماسیون | `apps/office-web` | React 19، Vite، راست‌به‌چپ، تقویم شمسی |
| API یکپارچه‌سازی سامانه جلسات | `apps/api/src/routes/integration.ts` | کلید API یا OAuth2، Webhook امضاشده، صف رویداد (Outbox) |
| صفحه «یکپارچه‌سازی» سامانه جلسات | `apps/web/src/pages/Integrations.tsx` | تعریف سامانه‌های خارجی، کلیدها و صف رویدادها |

## مستندات

1. [معماری و نگاشت به سند معماری](01-architecture.md)
2. [مدل داده](02-database.md)
3. [یکپارچگی با سامانه جلسات](03-integration.md)
4. [نصب، پیکربندی و راهنمای کاربری](04-operations.md)
5. [HTTPS بین مرورگر و سامانه](05-https.md)

مرجع کامل API: `apps/office-api/openapi.yaml` (در زمان اجرا: `GET /api/openapi.yaml`). API یکپارچه‌سازی سامانه جلسات در `apps/api/openapi.yaml` با برچسب‌های `Integration API` و `Integrations` آمده است.

## اجرای سریع (توسعه)

```bash
npm install
npm run build -w @kx/shared
createdb kx_office
npm run office:seed            # migration + ساختار سازمانی و کاربران نمونه
npm run dev:office-api         # http://localhost:4100
npm run dev:office-web         # http://localhost:5174
```

حساب‌های نمونه (رمز همه `Passw0rd!`):

| کاربر | سمت | نقش |
|---|---|---|
| `admin` | مسئول فناوری اطلاعات | مدیر سیستم |
| `president` | رئیس اتاق | رئیس (امضای نامه صادره) |
| `deputy` | معاون امور اعضا و تشکل‌ها | مدیر |
| `sechead`، `clerk` | دبیرخانه مرکزی | دبیرخانه (ثبت وارده و شماره صادره) |
| `cmshead`، `cmsexpert` | اداره امور کمیسیون‌ها | مدیر / کارشناس |
| `reshead`، `expert` | مرکز پژوهش‌ها | مدیر / کارشناس |
| `it` | واحد فناوری اطلاعات | کارشناس فناوری |

ایمیل‌های `cmshead` (`secretary@kx.local`)، `cmsexpert` (`member1@kx.local`)، `reshead` (`chair@kx.local`) و `expert` (`expert@kx.local`) با کاربران نمونه سامانه جلسات یکی است تا تطبیق افراد بین دو سامانه در محیط آزمایشی دیده شود.

برای اتصال دو سامانه در محیط توسعه، هر دو API را اجرا کنید و سپس:

```bash
cd apps/office-api
MEETINGS_URL=http://localhost:4000 MEETINGS_ADMIN_EMAIL=admin@kx.local MEETINGS_ADMIN_PASSWORD='Passw0rd!' \
OFFICE_WEBHOOK_URL=http://localhost:4100/api/integrations/meetings/webhook npx tsx src/db/connect-meetings.ts
```

## تست

```bash
npm test -w @kx/office-api
```

۲۳ تست با PostgreSQL واقعی اجرا می‌شود؛ تست سرتاسری (`test/meetings-e2e.test.ts`) خود API سامانه جلسات را روی پایگاه داده جداگانه بالا می‌آورد و سه سناریوی سند معماری را از طریق HTTP واقعی و Webhook امضاشده اجرا می‌کند.
