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

اسکریپت Node.js 22 و PostgreSQL را نصب، برنامه را build و سرویس systemd به نام `kx21` را روی پورت **8000** راه‌اندازی می‌کند (وب، API و WebSocket روی یک پورت). سامانه **بدون داده آزمایشی** و فقط با یک Super Admin (`root@kx.local`، یا نشانی `ADMIN_EMAIL`) ساخته می‌شود. رمز او تصادفی است، چاپ نمی‌شود و فقط در فایل `/root/kx21-admin.txt` (فقط root) است. `http://IP-سرور:8000` را باز کنید، وارد شوید، رمز را عوض و فایل را حذف کنید، سپس اتاق و مدیران آن را بسازید.

- نصب آزمایشی با داده نمونه (همه حساب‌ها با رمز عمومی `Passw0rd!`؛ هرگز برای استفاده واقعی): `sudo SEED=1 bash deploy/install.sh` — پورت دیگر: `sudo PORT=9000 bash deploy/install.sh`
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
npm run db:seed                              # migration + داده آزمایشی (در production رد می‌شود مگر با ALLOW_DEMO_SEED=1)
npm run dev:api                              # http://localhost:4000
npm run dev:web                              # http://localhost:5173
```

حساب‌های آزمایشی (رمز همه `Passw0rd!`): `admin@kx.local` (مدیر اتاق یزد)، `admin.isf@kx.local` (مدیر اتاق اصفهان)، `chair@kx.local` (رئیس کمیسیون تجارت یزد)، `secretary@kx.local` (دبیر)، `member1@kx.local` … `member6@kx.local` (اعضا)، `expert@kx.local`، `guest@kx.local`، `root@kx.local` (Super Admin).

### موبایل
```bash
cd apps/mobile
npm install
EXPO_PUBLIC_API_URL=http://<IP-سرور>:4000 npx expo start
```
برای Push روی دستگاه واقعی، پروژه را به EAS متصل کنید (`npx eas-cli init`) و Development Build بسازید.

### Docker (پیشنهادی برای نصب آزمایشی)
روی سروری که Docker و Docker Compose دارد:
```bash
git clone -b claude/commission-platform https://github.com/ardeshirazimi2000-design/kx21.git
cd kx21
bash deploy/docker-install.sh          # وب: http://IP-سرور:8000
```
اسکریپت یک‌بار فایل `.env` با رمزهای تصادفی می‌سازد (این فایل را نگه دارید)، سرویس‌ها را build و اجرا می‌کند و یک Super Admin با رمز تصادفی می‌سازد که فقط در فایل `admin-password.txt` (مجوز ۶۰۰) کنار مخزن است. داده آزمایشی فقط برای نصب آزمایشی: `SEED=1 bash deploy/docker-install.sh`؛ پورت دیگر: `WEB_PORT=9000 bash deploy/docker-install.sh`.

- لاگ: `docker compose logs -f api` — توقف: `docker compose down` — به‌روزرسانی: `git pull && bash deploy/docker-install.sh`
- داده‌ها در volumeهای `db-data` و `uploads` نگهداری می‌شوند؛ `docker compose down -v` همه داده‌ها را پاک می‌کند.

## بستهٔ نصب آفلاین (سرور بدون اینترنت، پورت 5000)

روی یک سرور دارای اینترنت و Docker (مثلاً همین سرور فعلی) بسته را بسازید؛ نصب فعلی دست نمی‌خورد:

```bash
bash deploy/offline/build-bundle.sh          # خروجی: dist-offline/kx21-offline-<نسخه>.tar
```

فایل tar را به سرور مقصد ببرید و `sudo bash install.sh` (با اطلاعات ارائهٔ شش استان) یا `sudo bash install.sh --empty` (خالی) را اجرا کنید. Docker در صورت نبودن از داخل بسته نصب می‌شود. راهنمای کامل و حساب‌های ارائه: `deploy/offline/راهنما.html`. اطلاعات ارائه (`dist/db/showcase.js`) فقط روی پایگاه‌دادهٔ خالی ساخته می‌شود.

## آماده‌سازی برای بهره‌برداری (حذف داده‌های آزمایشی)

همه اطلاعات (اتاق‌ها، اشخاص، کمیسیون‌ها، جلسات، مصوبات، شبکه‌ها، اعلان‌ها و فایل‌ها) حذف می‌شود و فقط حساب مدیر سامانه (root) با رمز جدید می‌ماند:

```bash
docker compose exec -e CONFIRM_RESET=DELETE-ALL-DATA -e ROOT_PASSWORD='رمز-جدید-قوی' \
  -e ROOT_EMAIL=it@example.ir -e ROOT_MOBILE=09xxxxxxxxx api node dist/db/reset.js
```

`ROOT_EMAIL`، `ROOT_MOBILE` و `ROOT_NAME` اختیاری‌اند. قبل از اجرا از پایگاه داده نسخه پشتیبان بگیرید؛ این کار برگشت‌پذیر نیست.

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
10. [ساخت فایل نصبی اپ اندروید](docs/10-mobile-build.md)

## اتوماسیون اداری (یکپارچه با سامانه جلسات)
سامانه اتوماسیون اداری (مکاتبات وارده/صادره/داخلی، گردش کار، بایگانی و امضای دیجیتال، دسترسی و ورود دومرحله‌ای، اعلان‌ها و گزارش‌ها) در `apps/office-api` و `apps/office-web` با پایگاه داده جدای `kx_office` قرار دارد و با این سامانه دوطرفه یکپارچه است: مصوبات به نامه و گردش پیگیری تبدیل می‌شوند، نامه‌ها به کمیسیون ارجاع می‌شوند و پیشرفت اجرا به مصوبه برمی‌گردد.

```bash
npm run office:seed        # migration + داده نمونه (createdb kx_office)
npm run dev:office-api     # http://localhost:4100
npm run dev:office-web     # http://localhost:5174 — ورود: admin، clerk، cmshead، expert، president … / Passw0rd!
npm test -w @kx/office-api
```
در نصب Docker و `deploy/install.sh` اتوماسیون روی پورت `8100` نصب و خودکار به سامانه جلسات وصل می‌شود (`OFFICE=0` برای صرف‌نظر). راه‌اندازی HTTPS: [docs/office/05-https.md](docs/office/05-https.md). مستندات: [docs/office](docs/office/README.md)
