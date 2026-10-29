# ۵. HTTPS بین مرورگر و سامانه (اصلاح F01)

این راهنما ارتباط مرورگر کاربران با اتوماسیون اداری را روی HTTPS می‌برد. تا وقتی هیچ‌کدام از متغیرهای زیر تنظیم نشود، نصب‌های فعلی دقیقاً مثل قبل کار می‌کنند (HTTP روی پورت `8100`). این تغییر **رمزنگاری ارتباط API با پایگاه داده (F28) را شامل نمی‌شود** و آن در PR جداگانه‌ای بررسی می‌شود.

> این راهنما و پیکربندی پیش‌فرض آن ادعای انطباق کامل با الزامات افتا را ندارد. تفاوت‌ها در بخش آخر آمده است و ارزیابی نهایی با آزمایشگاه است.

## چه چیزی تغییر کرده است

| بخش | رفتار |
|---|---|
| `office-web` (nginx) | با `OFFICE_TLS=1` روی ۴۴۳ داخل کانتینر HTTPS می‌دهد و پورت ۸۰ همه درخواست‌ها را با کد ۳۰۱ به HTTPS می‌برد (جز `/health` برای بررسی سلامت محلی). فقط TLS 1.2 و 1.3، مجموعه‌رمزهای ECDHE با AES-GCM و منحنی‌های P-256/384/521. |
| `office-web` (nginx) | سرآیندهای امنیتی روی همه پاسخ‌ها (از جمله `/assets`): `X-Content-Type-Options`، `X-Frame-Options: DENY`، `Referrer-Policy`، CSP در حالت **فقط گزارش** و HSTS فقط روی پاسخ‌های HTTPS. |
| `office-web` (nginx) | `X-Forwarded-For` و `X-Forwarded-Proto` که مرورگر می‌فرستد دور ریخته و با نشانی واقعی جایگزین می‌شود. فقط پراکسی‌های فهرست `OFFICE_TRUSTED_PROXIES` می‌توانند نشانی کاربر و HTTPS بودن اتصال را اعلام کنند. |
| `office-api` | `TRUST_PROXY` تعیین می‌کند به کدام پراکسی اعتماد شود. پیش‌فرض نصب systemd «هیچ‌کدام» است؛ در Docker فقط یک گام (nginx همین سامانه). `TRUST_PROXY=true` پذیرفته نمی‌شود. |
| `office-api` | با `PUBLIC_HTTPS=true` مسیرهای `/api/auth/*` (ورود، کد دومرحله‌ای، تمدید نشست، تغییر رمز) روی HTTP ساده با خطای ۴۰۳ `https_required` رد می‌شوند، **پیش از بررسی رمز**. HSTS و `upgrade-insecure-requests` هم فعال می‌شوند. در Production بدون `PUBLIC_HTTPS` هنگام شروع هشدار ثبت می‌شود. |
| `office-api` | `POST /api/csp-report` گزارش‌های نقض CSP مرورگر را فقط در لاگ (نوع دستور و نشانی مسدودشده) ثبت می‌کند. |

## پیش از شروع روی سرور

روی سرور سامانه‌های دیگری هم اجرا می‌شوند. پیش از هر تغییر:

```bash
sudo ss -ltnp                       # چه سرویسی روی کدام پورت است (80، 443، 8100، 8443)
docker ps --format '{{.Names}}\t{{.Ports}}'
systemctl status caddy 2>/dev/null | head -5; docker ps --filter name=caddy
```

* پیکربندی Caddy موجود را **بدون بررسی و پشتیبان‌گیری تغییر ندهید** (`sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)`). پس از هر تغییر `caddy validate` و سپس `systemctl reload caddy` (نه restart).
* پورت ۴۴۳ و ۸۰ در اختیار Caddy و پروژه‌های دیگر است؛ این سامانه آن‌ها را نمی‌گیرد. گزینه «ب» پیش‌فرض روی ۸۴۴۳ است.
* هرگز `docker compose down -v` اجرا نکنید (داده‌ها پاک می‌شوند).
* از `.env` و `/etc/kx21-office.env` پشتیبان بگیرید.

## گزینه الف (پیشنهادی وقتی Caddy روی سرور هست): Caddy جلوی سامانه

Caddy گواهی و TLS را مدیریت می‌کند و درخواست را به `127.0.0.1:8100` می‌فرستد. پورت ۸۱۰۰ دیگر از بیرون باز نیست.

۱. نشانی‌ای که Caddy از دید کانتینر `office-web` دارد را پیدا کنید. اگر Caddy روی خود میزبان (systemd) اجرا می‌شود، این نشانی دروازه شبکه Docker این پروژه است:

```bash
docker network inspect "$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' $(docker compose ps -q office-web))" \
  -f '{{(index .IPAM.Config 0).Gateway}}'          # مثلاً 172.18.0.1
```

اگر Caddy خودش کانتینر است، نشانی آن کانتینر در شبکه مشترک (یا زیرشبکه آن شبکه) را بدهید. برای اطمینان، پس از راه‌اندازی در لاگ `office-web` (`docker compose logs office-web`) ستون اول همان نشانی است که درخواست‌های Caddy از آن می‌آیند.

۲. در `.env` (کنار `docker-compose.yml`):

```dotenv
OFFICE_BIND=127.0.0.1                     # 8100 فقط روی loopback؛ فقط Caddy به آن دسترسی دارد
OFFICE_TRUSTED_PROXIES=172.18.0.1         # نشانی مرحله ۱
OFFICE_PUBLIC_URL=https://office.example.ir
OFFICE_PUBLIC_HTTPS=true                  # فقط وقتی HTTPS از مرورگر تا Caddy کار می‌کند
OFFICE_HSTS_MAX_AGE=300                   # ابتدا کوتاه؛ بخش HSTS را ببینید
```

`OFFICE_BIND=127.0.0.1` در این گزینه الزامی است: اتصال‌هایی که Docker از طریق `docker-proxy` (مثلاً IPv6) می‌رساند هم از نشانی دروازه می‌آیند و بدون آن، کاربر بیرونی می‌توانست خود را پراکسی مورد اعتماد جا بزند.

۳. یک بلوک **جدید** برای همین دامنه به Caddyfile اضافه کنید (بلوک‌های دیگر را دست نزنید):

```caddyfile
office.example.ir {
	reverse_proxy 127.0.0.1:8100
}
```

Caddy خودش `X-Forwarded-For` و `X-Forwarded-Proto` را می‌فرستد و مقدارهای ارسالی مرورگر را بازنویسی می‌کند. اگر Caddy با `trusted_proxies` پیکربندی شده باشد، پیش از تغییر بررسی کنید که پراکسی بیرونی‌تری هست یا نه.

۴. اعمال:

```bash
docker compose up -d --build office-web office-api      # فقط همین دو سرویس
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

اگر Caddy هم HTTP و هم HTTPS را برای این دامنه سرو کند، خودش HTTP را به HTTPS هدایت می‌کند. سرآیند HSTS را nginx این سامانه فقط وقتی می‌فرستد که Caddy (پراکسی مورد اعتماد) HTTPS بودن را اعلام کند.

## گزینه ب: HTTPS روی خود کانتینر `office-web`

برای وقتی که پراکسی جلویی نیست یا نمی‌خواهید Caddy را تغییر دهید.

۱. گواهی را **بیرون از مخزن** قرار دهید؛ هرگز گواهی یا کلید خصوصی را commit یا در `.env` کپی نکنید (`.gitignore` فایل‌های `*.pem`، `*.key` و پوشه `office-tls/` را نادیده می‌گیرد):

```bash
sudo install -d -m 750 /etc/kx21/office-tls
sudo cp fullchain.pem privkey.pem /etc/kx21/office-tls/     # زنجیره کامل (گواهی سرور + میانی) و کلید
sudo chmod 644 /etc/kx21/office-tls/fullchain.pem
sudo chmod 640 /etc/kx21/office-tls/privkey.pem
```

کانتینر nginx با کاربر root فایل‌ها را می‌خواند، پس مجوز ۶۴۰ با مالک root کافی است. گواهی باید `extendedKeyUsage=serverAuth` و نام دامنه یا IP در `subjectAltName` داشته باشد. کلید RSA حداقل ۲۰۴۸ بیت یا ECDSA روی P-256/P-384.

۲. در `.env`:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.office-tls.yml
OFFICE_TLS_DIR=/etc/kx21/office-tls
OFFICE_HTTPS_PORT=8443                       # پیش‌فرض؛ 443 را فقط اگر آزاد است بدهید
OFFICE_PUBLIC_URL=https://office.example.ir:8443
OFFICE_HSTS_MAX_AGE=300
```

`PUBLIC_HTTPS` در این حالت خودکار روشن است. پورت HTTP (`8100`) فقط به HTTPS هدایت می‌کند. برای بستن کامل آن از بیرون `OFFICE_BIND=127.0.0.1` هم بدهید (بررسی سلامت `deploy/docker-install.sh` از `127.0.0.1` کار می‌کند).

۳. `docker compose up -d --build office-web office-api` و باز کردن پورت ۸۴۴۳ در فایروال سرور (`ufw allow 8443/tcp`).

تمدید گواهی: فایل‌ها را جایگزین و `docker compose restart office-web` کنید. اگر گواهی یا کلید پیدا نشود، `office-web` بالا نمی‌آید (عمداً، تا به HTTP ساده برنگردد) و علت در `docker compose logs office-web` است.

## نصب بدون Docker (systemd)

`deploy/install.sh` سرویس را روی `PORT=4100` اجرا می‌کند. پراکسی (Caddy یا nginx) را جدا نصب کنید و سپس دوباره نصب را اجرا کنید؛ مقدارهای قبلی نگه داشته می‌شوند:

```bash
sudo OFFICE_PUBLIC_URL=https://office.example.ir OFFICE_HOST=127.0.0.1 OFFICE_TRUST_PROXY=loopback \
     OFFICE_PUBLIC_HTTPS=true bash deploy/install.sh
```

یا مستقیم در `/etc/kx21-office.env` و سپس `systemctl restart kx21-office`:

```dotenv
HOST=127.0.0.1           # فقط پراکسی روی همین سرور به API دسترسی دارد
TRUST_PROXY=loopback     # یا 127.0.0.1؛ بدون پراکسی خالی بماند
PUBLIC_HTTPS=true
```

بدون پراکسی، `TRUST_PROXY` را خالی بگذارید: آنگاه `X-Forwarded-For` و `X-Forwarded-Proto` هیچ اثری ندارند و نشانی ثبت‌شده در ممیزی نشانی واقعی اتصال است. با `OFFICE_HOST=127.0.0.1` اسکریپت پورت اتوماسیون را در ufw باز نمی‌کند.

## متغیرها

| متغیر (`.env` Docker) | متغیر سرویس | پیش‌فرض | توضیح |
|---|---|---|---|
| `OFFICE_BIND` | — | خالی (همه نشانی‌ها) | `127.0.0.1` برای بستن ۸۱۰۰ از بیرون |
| `OFFICE_TRUSTED_PROXIES` | nginx | خالی | نشانی/CIDR پراکسی جلویی، با کاما |
| `OFFICE_PUBLIC_HTTPS` | `PUBLIC_HTTPS` | `false` | ورود فقط روی HTTPS، HSTS در API |
| `OFFICE_TRUST_PROXY` | `TRUST_PROXY` | Docker: `1`، systemd: خالی | عدد گام، یا نشانی/CIDR/`loopback`. `true` رد می‌شود |
| `OFFICE_HSTS_MAX_AGE` | `HSTS_MAX_AGE` | `86400` | ثانیه، یا `off` |
| — | `HSTS_INCLUDE_SUBDOMAINS` / `OFFICE_HSTS_INCLUDE_SUBDOMAINS` | خاموش | فقط وقتی همه زیردامنه‌ها HTTPS دارند |
| `OFFICE_CSP_MODE` | nginx | `report-only` | `report-only`، `enforce` یا `off` |
| `OFFICE_TLS_DIR`، `OFFICE_HTTPS_PORT`، `OFFICE_HTTPS_BIND` | گزینه ب | —، `8443`، خالی | پوشه گواهی، پورت HTTPS، نشانی گوش‌دادن |
| — | `OFFICE_TLS_PROTOCOLS` / `OFFICE_TLS_CIPHERS` | `TLSv1.2 TLSv1.3` / ECDHE-AES-GCM | فقط TLSv1.2 و TLSv1.3 پذیرفته می‌شود |
| — | `HOST` (systemd) | خالی | نشانی گوش‌دادن API |

## HSTS

HSTS را با مقدار کوتاه شروع کنید (`300`)، پس از یک هفته بدون مشکل به `86400` و سپس `31536000` برسانید. HSTS فقط روی پاسخ HTTPS فرستاده می‌شود و تا پایان `max-age` مرورگر نسخه HTTP را باز نمی‌کند؛ پس اگر احتمال برگشت به HTTP هست، مقدار را بالا نبرید. `includeSubDomains` و `preload` پیش‌فرض خاموش‌اند چون دامنه‌های دیگر اتاق ممکن است HTTPS نداشته باشند.

## CSP

CSP ابتدا در حالت `Content-Security-Policy-Report-Only` است تا ویرایشگر TipTap، چاپ نامه و QR شکسته نشوند. گزارش‌ها در لاگ `office-api` با پیام `content security policy violation` ثبت می‌شوند (`docker compose logs office-api | grep "content security"`). پس از چند هفته بدون گزارش در کار روزانه (ایجاد، ویرایش، امضا، چاپ نامه و صحت‌سنجی QR)، `OFFICE_CSP_MODE=enforce` را آزمایش کنید. فونت‌ها از Google Fonts بارگذاری می‌شوند و در سیاست مجاز شده‌اند؛ برای شبکه بدون اینترنت بهتر است فونت‌ها محلی شوند (کار جدا).

## بررسی پس از استقرار

```bash
curl -sI http://office.example.ir/        # 301 به https:// (یا رفتار Caddy)
curl -sI https://office.example.ir/ | grep -iE 'strict-transport|content-security|x-frame'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8100/api/auth/login \
  -H 'content-type: application/json' -d '{"identifier":"x","password":"x"}'   # گزینه الف: 403 (https_required)
testssl.sh --protocols --ciphers --server-defaults office.example.ir        # یا sslscan
```

انتظار: SSLv3 و TLS 1.0/1.1 رد، فقط چهار مجموعه‌رمز ECDHE-*-AES-GCM در TLS 1.2، گواهی معتبر با زنجیره کامل. خروجی testssl را به‌عنوان شاهد ارزیابی نگه دارید (بدون کلید خصوصی).

## بازگشت (Rollback)

این تغییر migration پایگاه داده ندارد. به ترتیب:

1. **فقط خاموش کردن HTTPS:** در `.env` خط‌های `COMPOSE_FILE`، `OFFICE_PUBLIC_HTTPS`، `OFFICE_BIND` و `OFFICE_TRUSTED_PROXIES` را حذف یا کامنت کنید و `docker compose up -d office-web office-api`. اگر Caddy تغییر کرده، Caddyfile پشتیبان را برگردانید و `systemctl reload caddy`. در systemd مقدار `PUBLIC_HTTPS=false` و `HOST=` و سپس `systemctl restart kx21-office`.
2. **برگشت کامل کد:** `git checkout <commit قبلی>` و `docker compose up -d --build office-web office-api`.
3. اگر HSTS با مقدار بلند فرستاده شده، مرورگرهای کاربران تا پایان آن مدت فقط HTTPS را باز می‌کنند؛ پس پیش از برگشت به HTTP، `OFFICE_HSTS_MAX_AGE=0` را روی HTTPS بفرستید (برای پاک شدن HSTS در مرورگرها) یا HTTPS را نگه دارید.

## تفاوت با الزامات افتا بند ۳.۲ تا ۳.۵

مرجع: ماتریس انطباق `matris-enteghag-efta` (ستون «بند»). این تفاوت‌ها آگاهانه‌اند یا خارج از این تغییرند:

| بند | الزام (خلاصه) | وضعیت در این تغییر |
|---|---|---|
| ۳.۳ الزام ۵ | سرور TLS 1.2 با مجموعه‌رمزهای فهرست | پیاده شده: چهار مجموعه ECDHE-ECDSA/RSA با AES-128/256-GCM (TS-05.n تا q). مجموعه‌های CBC فهرست عمداً فعال نیستند. |
| ۳.۳ الزام ۶ | رد SSL و TLS 1.0/1.1 | پیاده شده و در آزمون بررسی می‌شود. |
| ۳.۳ الزام ۷ | ECDH فقط با P-256/384/521 | پیاده شده (`ssl_ecdh_curve`)؛ کلید گواهی به گواهی تهیه‌شده بستگی دارد. |
| ۳.۲ / ۳.۳ | فقط TLS 1.2 | **تفاوت:** TLS 1.3 هم به‌طور پیش‌فرض فعال است (فقط `TLS_AES_256_GCM_SHA384` و `TLS_AES_128_GCM_SHA256`)، چون در سند صراحتاً نیامده و امن‌تر است. با `OFFICE_TLS_PROTOCOLS=TLSv1.2` خاموش می‌شود؛ تصمیم با کارفرما/آزمایشگاه. در گزینه الف تنظیمات TLS را Caddy تعیین می‌کند و باید جدا تنظیم و بررسی شود. |
| ۳.۲ الزام ۲ تا ۴ و ۳.۱ الزام ۳ | سمت کلاینت TLS: بررسی نام و گواهی سرور مقابل، منحنی‌ها در ClientHello | **خارج از این تغییر.** اتصال‌های خروجی سامانه (یکپارچه‌سازی، AI، SMTP) تغییر نکرده‌اند. |
| ۳.۴ | احراز هویت دوطرفه با گواهی (mTLS) | **پیاده نشده.** |
| ۳.۵ | اعتبارسنجی گواهی، OCSP/CRL، EKU | گواهی سرور باید `serverAuth` داشته باشد (مسئولیت تهیه‌کننده گواهی). OCSP stapling فعال نشده و بررسی فسخ در سامانه پیاده نشده است. |
| ۲.۶ الزام ۲ (F28) | رمزنگاری بین اجزا (API↔پایگاه داده) | **خارج از این تغییر.** nginx↔API داخل شبکه Docker یا loopback و API↔PostgreSQL بدون TLS باقی است. |
