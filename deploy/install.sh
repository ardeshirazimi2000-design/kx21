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
#   OFFICE=1             also install office automation (اتوماسیون اداری) on $OFFICE_PORT — use 0 to skip
#   OFFICE_PORT=8100     office automation port
#   OFFICE_SEED=0        office automation starts empty with one administrator whose random password is written
#                        to $OFFICE_ADMIN_FILE (root only); OFFICE_SEED=1 loads demo accounts (password Passw0rd!)
#                        instead — trial installs only
#   OFFICE_ADMIN_USERNAME=admin
#   MEETINGS_ADMIN_EMAIL / MEETINGS_ADMIN_PASSWORD   a meetings admin, to connect the two systems on first install
#                        (defaults to the demo admin when SEED=1)
set -euo pipefail

PORT="${PORT:-8000}"
SEED="${SEED:-1}"
APP_DIR="${APP_DIR:-/opt/kx21}"
APP_USER=kx
ENV_FILE=/etc/kx21.env
OFFICE="${OFFICE:-1}"
OFFICE_PORT="${OFFICE_PORT:-8100}"
OFFICE_ENV_FILE=/etc/kx21-office.env
OFFICE_SEED="${OFFICE_SEED:-0}"
OFFICE_ADMIN_USERNAME="${OFFICE_ADMIN_USERNAME:-admin}"
OFFICE_ADMIN_FILE=/root/kx21-office-admin.txt
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
if [ "$OFFICE" = "1" ]; then
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='kx_office'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE kx_office OWNER kx"
  if [ -f "$OFFICE_ENV_FILE" ]; then
    OFFICE_JWT_SECRET="$(grep '^JWT_SECRET=' "$OFFICE_ENV_FILE" | cut -d= -f2-)"
    OFFICE_DATA_KEY="$(grep '^DATA_ENCRYPTION_KEY=' "$OFFICE_ENV_FILE" | cut -d= -f2-)"
    OFFICE_FIRST=0
  else
    OFFICE_JWT_SECRET="$(openssl rand -hex 32)"
    OFFICE_DATA_KEY="$(openssl rand -hex 32)"
    OFFICE_FIRST=1
  fi
fi

log "Copying application to $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/lib/kx21/uploads /var/lib/kx21/office-storage
rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude apps/mobile "$SRC_DIR/" "$APP_DIR/"

log "Installing dependencies and building (a few minutes)"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build -w @kx/shared
npm run build -w @kx/api
npm run build -w @kx/web
if [ "$OFFICE" = "1" ]; then
  npm run build -w @kx/office-api
  npm run build -w @kx/office-web
fi

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
IDENTITY_PROVIDER=${IDENTITY_PROVIDER:-none}
IDENTITY_API_TOKEN=${IDENTITY_API_TOKEN:-}
IDENTITY_REQUIRED=${IDENTITY_REQUIRED:-false}
ENV
chmod 600 "$ENV_FILE"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/lib/kx21

log "Running database migrations"
sudo -u "$APP_USER" env $(grep -v '^#' "$ENV_FILE" | xargs) node "$APP_DIR/apps/api/dist/db/migrate.js"
if [ "$SEED" = "1" ]; then
  log "Loading demo data"
  sudo -u "$APP_USER" env $(grep -v '^#' "$ENV_FILE" | xargs) node "$APP_DIR/apps/api/dist/db/seed.js"
fi

if [ "$OFFICE" = "1" ]; then
  cat > "$OFFICE_ENV_FILE" <<ENV
NODE_ENV=production
TZ=Asia/Tehran
PORT=$OFFICE_PORT
DATABASE_URL=postgres://kx:$DB_PASS@localhost:5432/kx_office
JWT_SECRET=$OFFICE_JWT_SECRET
DATA_ENCRYPTION_KEY=$OFFICE_DATA_KEY
WEB_DIST_DIR=$APP_DIR/apps/office-web/dist
STORAGE_DIR=/var/lib/kx21/office-storage
PUBLIC_URL=http://$SERVER_IP:$OFFICE_PORT
CORS_ORIGINS=http://$SERVER_IP:$OFFICE_PORT,http://localhost:$OFFICE_PORT
SMS_PROVIDER=log
EMAIL_PROVIDER=log
ENV
  chmod 600 "$OFFICE_ENV_FILE"
  chown -R "$APP_USER:$APP_USER" /var/lib/kx21
  log "Office automation: migrations"
  sudo -u "$APP_USER" env $(grep -v '^#' "$OFFICE_ENV_FILE" | xargs) node "$APP_DIR/apps/office-api/dist/db/migrate.js"
  if [ "$OFFICE_FIRST" = "1" ] && [ "$OFFICE_SEED" = "1" ]; then
    log "Office automation: demo data (trial install)"
    sudo -u "$APP_USER" env $(grep -v '^#' "$OFFICE_ENV_FILE" | xargs) ALLOW_DEMO_SEED=1 node "$APP_DIR/apps/office-api/dist/db/seed.js"
  elif [ "$OFFICE_FIRST" = "1" ]; then
    log "Office automation: first administrator"
    # Random password, kept only in a root-only file (never printed or put in an environment variable).
    (umask 077; openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 > "$OFFICE_ADMIN_FILE")
    sudo -u "$APP_USER" env $(grep -v '^#' "$OFFICE_ENV_FILE" | xargs) ADMIN_USERNAME="$OFFICE_ADMIN_USERNAME" \
      node "$APP_DIR/apps/office-api/dist/db/create-admin.js" < "$OFFICE_ADMIN_FILE"
  fi
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
if [ "$OFFICE" = "1" ]; then
  cat > /etc/systemd/system/kx21-office.service <<UNIT
[Unit]
Description=Office automation (integrated with the commissions platform)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=$APP_USER
EnvironmentFile=$OFFICE_ENV_FILE
WorkingDirectory=$APP_DIR/apps/office-api
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
systemctl enable kx21
systemctl restart kx21
if [ "$OFFICE" = "1" ]; then
  systemctl enable kx21-office
  systemctl restart kx21-office
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT/tcp"
  [ "$OFFICE" = "1" ] && ufw allow "$OFFICE_PORT/tcp"
fi

log "Waiting for the service"
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { journalctl -u kx21 -n 50 --no-pager; exit 1; }

if [ "$OFFICE" = "1" ]; then
  for _ in $(seq 1 30); do
    curl -fs "http://127.0.0.1:$OFFICE_PORT/health" >/dev/null && break
    sleep 1
  done
  curl -fs "http://127.0.0.1:$OFFICE_PORT/health" >/dev/null || { journalctl -u kx21-office -n 50 --no-pager; exit 1; }
  # Connecting needs a meetings admin: the demo one when the meetings demo data was loaded, otherwise given explicitly.
  if [ "$SEED" = "1" ]; then
    MEETINGS_ADMIN_EMAIL="${MEETINGS_ADMIN_EMAIL:-admin@kx.local}"
    MEETINGS_ADMIN_PASSWORD="${MEETINGS_ADMIN_PASSWORD:-Passw0rd!}"
  fi
  if [ "$OFFICE_FIRST" = "1" ] && [ -n "${MEETINGS_ADMIN_EMAIL:-}" ] && [ -n "${MEETINGS_ADMIN_PASSWORD:-}" ]; then
    log "Connecting office automation to the meetings system"
    sudo -u "$APP_USER" env $(grep -v '^#' "$OFFICE_ENV_FILE" | xargs) MEETINGS_URL="http://127.0.0.1:$PORT" \
      MEETINGS_ADMIN_EMAIL="$MEETINGS_ADMIN_EMAIL" MEETINGS_ADMIN_PASSWORD="$MEETINGS_ADMIN_PASSWORD" \
      OFFICE_WEBHOOK_URL="http://127.0.0.1:$OFFICE_PORT/api/integrations/meetings/webhook" \
      node "$APP_DIR/apps/office-api/dist/db/connect-meetings.js" || echo "Connect later from the office automation «یکپارچه‌سازی» page."
  fi
fi

echo
echo "Installed. Open:  http://$SERVER_IP:$PORT"
[ "$SEED" = "1" ] && echo "Demo login: admin@kx.local / Passw0rd!   (also chair@, secretary@, member1@kx.local)"
echo "Logs:     journalctl -u kx21 -f"
echo "Config:   $ENV_FILE   (after editing: systemctl restart kx21)"
if [ "$OFFICE" = "1" ]; then
  echo
  echo "Office automation:  http://$SERVER_IP:$OFFICE_PORT"
  if [ "$OFFICE_SEED" = "1" ]; then
    echo "Demo login: admin, clerk, cmshead, expert, president … / Passw0rd!  (trial only: change or remove before real use)"
  elif [ "$OFFICE_FIRST" = "1" ]; then
    echo "Administrator: $OFFICE_ADMIN_USERNAME — password in $OFFICE_ADMIN_FILE (root only). Change it after signing in, then delete the file."
  fi
  echo "Logs:     journalctl -u kx21-office -f    Config: $OFFICE_ENV_FILE"
fi
