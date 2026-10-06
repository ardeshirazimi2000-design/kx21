#!/usr/bin/env bash
# Trial install of the commissions platform on one Ubuntu 22.04/24.04 server.
# Everything (web app + API + WebSocket) is served by a single Node process on $PORT.
#
#   git clone -b claude/commission-platform https://github.com/ardeshirazimi2000-design/kx21.git
#   cd kx21 && sudo bash deploy/install.sh
#
# Options (environment variables):
#   PORT=8000            listening port
#   SEED=1               load demo data (accounts with password Passw0rd!) — use 0 for an empty install
#   NPM_REGISTRY=...     npm mirror if registry.npmjs.org is not reachable
#   APP_DIR=/opt/kx21    install location
set -euo pipefail

PORT="${PORT:-8000}"
SEED="${SEED:-1}"
APP_DIR="${APP_DIR:-/opt/kx21}"
APP_USER=kx
ENV_FILE=/etc/kx21.env
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }
log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

log "Installing system packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg postgresql postgresql-contrib rsync openssl

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
[ -n "${NPM_REGISTRY:-}" ] && npm config set registry "$NPM_REGISTRY"

log "Preparing PostgreSQL"
systemctl enable --now postgresql
if [ -f "$ENV_FILE" ]; then
  # Re-install: keep existing secrets and database password.
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  DB_PASS="$(echo "$DATABASE_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')"
else
  DB_PASS="$(openssl rand -hex 16)"
  JWT_SECRET="$(openssl rand -hex 32)"
fi
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='kx'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE kx LOGIN PASSWORD '$DB_PASS'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='kx'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE kx OWNER kx"

log "Copying application to $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/lib/kx21/uploads
rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude apps/mobile "$SRC_DIR/" "$APP_DIR/"

log "Installing dependencies and building (a few minutes)"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build -w @kx/shared
npm run build -w @kx/api
npm run build -w @kx/web

SERVER_IP="$(hostname -I | awk '{print $1}')"
cat > "$ENV_FILE" <<ENV
NODE_ENV=production
TZ=Asia/Tehran
PORT=$PORT
DATABASE_URL=postgres://kx:$DB_PASS@localhost:5432/kx
JWT_SECRET=$JWT_SECRET
WEB_DIST_DIR=$APP_DIR/apps/web/dist
UPLOAD_DIR=/var/lib/kx21/uploads
CORS_ORIGINS=http://$SERVER_IP:$PORT,http://localhost:$PORT
SMS_PROVIDER=log
PUSH_PROVIDER=expo
ENV
chmod 600 "$ENV_FILE"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/lib/kx21

log "Running database migrations"
sudo -u "$APP_USER" env $(grep -v '^#' "$ENV_FILE" | xargs) node "$APP_DIR/apps/api/dist/db/migrate.js"
if [ "$SEED" = "1" ]; then
  log "Loading demo data"
  sudo -u "$APP_USER" env $(grep -v '^#' "$ENV_FILE" | xargs) node "$APP_DIR/apps/api/dist/db/seed.js"
fi

log "Creating systemd service kx21"
cat > /etc/systemd/system/kx21.service <<UNIT
[Unit]
Description=Chamber commissions platform
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR/apps/api
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable kx21
systemctl restart kx21

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT/tcp"
fi

log "Waiting for the service"
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { journalctl -u kx21 -n 50 --no-pager; exit 1; }

echo
echo "Installed. Open:  http://$SERVER_IP:$PORT"
[ "$SEED" = "1" ] && echo "Demo login: admin@kx.local / Passw0rd!   (also chair@, secretary@, member1@kx.local)"
echo "Logs:     journalctl -u kx21 -f"
echo "Config:   $ENV_FILE   (after editing: systemctl restart kx21)"
