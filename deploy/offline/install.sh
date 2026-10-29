#!/usr/bin/env bash
# نصب آفلاین سامانهٔ کمیسیون‌های تخصصی — Offline install of the commissions system.
#
#   sudo bash install.sh            نصب با اطلاعات ارائه (شش اتاق استانی نمونه) — presentation data
#   sudo bash install.sh --empty    نصب خالی برای استفادهٔ واقعی — empty, for real use
#
# Needs no internet: Docker (if missing) and every image come from this folder. Re-running it with a newer bundle
# upgrades the system and keeps its data. Options (environment variables):
#   WEB_PORT=5000            port of the web interface
#   INSTALL_DIR=/opt/kx21    where the configuration (.env), scripts and admin password file are kept
#   ADMIN_EMAIL              super admin login (default root@demo.ir with presentation data, root@kx.local otherwise)
#   SHOWCASE_PASSWORD        password of all presentation accounts (default Demo@1405)
set -euo pipefail
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
MODE=demo
for a in "$@"; do
  case "$a" in
    --empty) MODE=empty ;;
    --demo) MODE=demo ;;
    *) echo "گزینهٔ نامعتبر: $a  (--demo یا --empty)"; exit 2 ;;
  esac
done
WEB_PORT="${WEB_PORT:-5000}"
INSTALL_DIR="${INSTALL_DIR:-/opt/kx21}"
VERSION="$(cat "$BUNDLE/VERSION")"

say() { echo "==> $*"; }
die() { echo "خطا: $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "با sudo یا کاربر root اجرا کنید: sudo bash install.sh"
[ "$(uname -m)" = "x86_64" ] || die "این بسته برای سرور ۶۴ بیتی x86_64 ساخته شده است (این سرور: $(uname -m))"
say "بررسی سالم بودن فایل‌های بسته…"
(cd "$BUNDLE" && sha256sum -c --quiet SHA256SUMS) || die "فایل‌های بسته ناقص یا خراب منتقل شده‌اند؛ دوباره کپی کنید"

# ───── 1. Docker ─────
install_docker() {
  say "نصب Docker از داخل بسته (بدون اینترنت)…"
  command -v systemctl >/dev/null || die "این سرور systemd ندارد؛ Docker را دستی نصب کنید و دوباره اجرا کنید"
  tar -xzf "$BUNDLE"/docker/docker-*.tgz -C /tmp
  install -m 755 /tmp/docker/* /usr/local/bin/
  rm -rf /tmp/docker
  getent group docker >/dev/null || groupadd --system docker
  cat > /etc/systemd/system/containerd.service <<'UNIT'
[Unit]
Description=containerd container runtime
After=network.target
[Service]
ExecStart=/usr/local/bin/containerd
Restart=always
Delegate=yes
KillMode=process
LimitNOFILE=infinity
[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=Docker Engine
After=network-online.target containerd.service
Wants=network-online.target containerd.service
[Service]
ExecStart=/usr/local/bin/dockerd --containerd=/run/containerd/containerd.sock
Restart=always
LimitNOFILE=infinity
Delegate=yes
KillMode=process
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now containerd docker
}
install_compose() {
  say "نصب Docker Compose از داخل بسته…"
  install -D -m 755 "$BUNDLE/docker/docker-compose" /usr/local/lib/docker/cli-plugins/docker-compose
}
command -v docker >/dev/null || install_docker
docker compose version >/dev/null 2>&1 || install_compose
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || die "سرویس Docker اجرا نشد (systemctl status docker)"

# ───── 2. Images ─────
say "بارگذاری ایمیج‌های سامانه (چند دقیقه)…"
docker load -i "$BUNDLE/images/kx21-images.tar.gz" >/dev/null

# ───── 3. Configuration ─────
mkdir -p "$INSTALL_DIR/deploy"
cp "$BUNDLE/docker-compose.yml" "$INSTALL_DIR/"
cp "$BUNDLE/deploy/backup.sh" "$BUNDLE/deploy/restore.sh" "$INSTALL_DIR/deploy/"
cd "$INSTALL_DIR"
FIRST=0
if [ ! -f .env ]; then
  FIRST=1
  # A database left by an earlier install would not open with the new password, and must not be overwritten.
  if docker volume inspect kx21-offline_db-data >/dev/null 2>&1; then
    die "اطلاعات یک نصب قبلی (حجم kx21-offline_db-data) روی این سرور هست ولی فایل $INSTALL_DIR/.env آن نیست؛ .env قبلی را برگردانید، یا اگر آن اطلاعات لازم نیست: docker volume rm kx21-offline_db-data kx21-offline_uploads"
  fi
  if command -v ss >/dev/null && ss -ltn "sport = :$WEB_PORT" | grep -q LISTEN; then
    die "پورت $WEB_PORT در این سرور اشغال است؛ با WEB_PORT=… پورت دیگری بدهید"
  fi
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  (umask 077; cat > .env <<ENV
KX_VERSION=$VERSION
WEB_PORT=$WEB_PORT
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
CORS_ORIGINS=http://${IP:-localhost}:$WEB_PORT,http://localhost:$WEB_PORT
SMS_PROVIDER=log
IDENTITY_PROVIDER=none
IDENTITY_API_TOKEN=
IDENTITY_REQUIRED=false
ENV
  )
  say "پیکربندی در $INSTALL_DIR/.env ساخته شد (رمز پایگاه‌داده و کلید امضا؛ از آن نگهداری کنید)."
else
  sed -i "s/^KX_VERSION=.*/KX_VERSION=$VERSION/" .env
  say "نصب قبلی پیدا شد؛ ارتقا به نسخهٔ $VERSION با حفظ اطلاعات."
fi
set -a; . ./.env; set +a

# ───── 4. Start ─────
say "راه‌اندازی سامانه…"
docker compose up -d
for _ in $(seq 1 90); do curl -fs "http://127.0.0.1:${WEB_PORT}/health" >/dev/null && break; sleep 2; done
curl -fs "http://127.0.0.1:${WEB_PORT}/health" >/dev/null || { docker compose logs --tail 50 api; die "سامانه بالا نیامد"; }

# ───── 5. First super admin, then presentation data ─────
ADMIN_FILE="$INSTALL_DIR/admin-password.txt"
if [ "$FIRST" = "1" ]; then
  ADMIN_EMAIL="${ADMIN_EMAIL:-$([ "$MODE" = demo ] && echo root@demo.ir || echo root@kx.local)}"
  (umask 077; openssl rand -base64 24 | tr -d '/+=' | cut -c1-20 > "$ADMIN_FILE")
  docker compose exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" api node dist/db/create-admin.js < "$ADMIN_FILE"
  if [ "$MODE" = demo ]; then
    say "ساخت اطلاعات ارائه (شش اتاق، ۱۸ کمیسیون، جلسات، مصوبات و شبکه‌ها) — حدود یک دقیقه…"
    docker compose exec -T -e ALLOW_DEMO_SEED=1 -e LOG_LEVEL=warn -e SHOWCASE_PASSWORD="${SHOWCASE_PASSWORD:-}" api node dist/db/showcase.js
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "سامانه آماده است:   http://${IP:-localhost}:${WEB_PORT}"
if [ "$FIRST" = "1" ]; then
  echo "مدیر سامانه:        ${ADMIN_EMAIL}   — رمز در فایل $ADMIN_FILE"
  [ "$MODE" = demo ] && echo "حساب‌های ارائه:      رمز همه ${SHOWCASE_PASSWORD:-Demo@1405} — فهرست در «راهنما.html»"
fi
echo "پشتیبان‌گیری:       sudo OFFICE=0 bash $INSTALL_DIR/deploy/backup.sh"
