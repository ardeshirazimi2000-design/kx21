# سامانه مکانیزه کمیسیون‌های تخصصی اتاق بازرگانی

پلتفرم چنداتاقی (Multi-Tenant)، چنددوره‌ای و چندکمیسیونی برای مدیریت چرخه کامل کمیسیون‌ها:
**اتاق ← دوره ← کمیسیون ← عضو/سمت ← جلسه ← دستور جلسه ← حضور ← حد نصاب ← اجرای زنده ← رأی‌گیری ← صورتجلسه ← مصوبه ← پیگیری ← گزارش**

| بخش | مسیر | فناوری |
|---|---|---|
| قواعد کسب‌وکار مشترک | `packages/shared` | TypeScript (state machine، نصاب، آرا، مجوزها، تقویم شمسی) |
| API + Real-time | `apps/api` | Node 22، Express 5، PostgreSQL 16، Socket.IO |
| وب‌اپلیکیشن | `apps/web` | React 19، Vite، RTL |
| اپ موبایل (Android/iOS) | `apps/mobile` | Expo SDK 57، expo-router |
| مستندات | `docs/` | معماری، دیتابیس، API، مجوزها، چرخه جلسه، اعلان‌ها، تست، تصمیم‌ها، راهنما |

## اجرای سریع (توسعه)

پیش‌نیاز: Node.js 22 و PostgreSQL 16.

```bash
npm install
npm run build -w @kx/shared
cp apps/api/.env.example apps/api/.env      # DATABASE_URL را تنظیم کنید
createdb kx                                  # یا از docker compose برای Postgres استفاده کنید
npm run db:seed                              # migration + داده آزمایشی
npm run dev:api                              # http://localhost:4000
npm run dev:web                              # http://localhost:5173
```

حساب‌های آزمایشی (رمز همه `Passw0rd!`): `admin@kx.local` (مدیر اتاق)، `chair@kx.local` (رئیس)، `secretary@kx.local` (دبیر)، `member1@kx.local` … `member6@kx.local` (اعضا)، `expert@kx.local`، `guest@kx.local`، `root@kx.local` (Super Admin).

### موبایل
```bash
cd apps/mobile
npm install
EXPO_PUBLIC_API_URL=http://<IP-سرور>:4000 npx expo start
```
برای Push روی دستگاه واقعی، پروژه را به EAS متصل کنید (`npx eas-cli init`) و Development Build بسازید.

### Docker
```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build   # وب: http://localhost:8080
docker compose exec api node dist/db/seed.js                    # اختیاری: داده آزمایشی
```

## تست
```bash
npm test -w @kx/shared      # unit
npm test -w @kx/api         # یکپارچه/E2E با PostgreSQL (TEST_DATABASE_URL، پیش‌فرض kx_test)
npm run typecheck
```

## مستندات
1. [معماری، امنیت و استقرار](docs/01-architecture.md)
2. [پایگاه داده](docs/02-database.md)
3. [API و رویدادهای زنده](docs/03-api.md) — [OpenAPI](apps/api/openapi.yaml)
4. [ماتریس مجوزها](docs/04-permissions.md)
5. [چرخه عمر جلسه و قواعد](docs/05-meeting-lifecycle.md)
6. [اعلان‌ها](docs/06-notifications.md)
7. [تست و معیارهای پذیرش](docs/07-testing-and-acceptance.md)
8. [تصمیم‌های محصول برای تأیید](docs/08-product-decisions.md)
9. [راهنمای کاربران و مدیران](docs/09-user-manual.md)
