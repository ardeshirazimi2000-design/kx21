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

## نصب آزمایشی روی سرور (پورت 8000)

روی یک سرور Ubuntu 22.04 یا 24.04 (حداقل ۲ گیگ RAM):

```bash
git clone -b claude/commission-platform https://github.com/ardeshirazimi2000-design/kx21.git
cd kx21
sudo bash deploy/install.sh
```

اسکریپت Node.js 22 و PostgreSQL را نصب، برنامه را build و سرویس systemd به نام `kx21` را روی پورت **8000** راه‌اندازی می‌کند (وب، API و WebSocket روی یک پورت). سپس `http://IP-سرور:8000` را باز کنید و با `admin@kx.local` / `Passw0rd!` وارد شوید.

- نصب بدون داده آزمایشی: `sudo SEED=0 bash deploy/install.sh` — پورت دیگر: `sudo PORT=9000 bash deploy/install.sh`
- اگر دسترسی به npm محدود است: `sudo NPM_REGISTRY=<آدرس mirror> bash deploy/install.sh`
- لاگ‌ها: `journalctl -u kx21 -f` — تنظیمات: `/etc/kx21.env` (پس از تغییر: `systemctl restart kx21`)
- به‌روزرسانی: `git pull` و اجرای دوباره همان اسکریپت (رمزها و داده‌ها حفظ می‌شوند)
- پس از راه‌اندازی HTTPS (مثلاً nginx + certbot)، در `/etc/kx21.env` مقدار `PUBLIC_HTTPS=true` را اضافه کنید.

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
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build   # وب: http://localhost:8000
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
