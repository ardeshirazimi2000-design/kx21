#!/usr/bin/env bash
# Trial install with Docker:  bash deploy/docker-install.sh
# Creates .env with random secrets (once), builds and starts the stack on $WEB_PORT (default 8000)
# The meetings system starts empty with one super admin ($ADMIN_EMAIL, default root@kx.local) whose random password
# is written to admin-password.txt (mode 600, never printed); SEED=1 loads its demo data instead — trial installs only.
# Office automation starts empty with one administrator ($OFFICE_ADMIN_USERNAME, default admin) whose random
# password is written to office-admin-password.txt (mode 600, never printed); OFFICE_SEED=1 loads its demo
# accounts (password Passw0rd!) instead — trial installs only.
# MEETINGS_ADMIN_EMAIL / MEETINGS_ADMIN_PASSWORD: a meetings admin, to connect the two systems on first install
# (defaults to the demo admin when SEED=1).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  PORT="${WEB_PORT:-8000}"
  cat > .env <<ENV
WEB_PORT=$PORT
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
CORS_ORIGINS=http://${IP:-localhost}:$PORT,http://localhost:$PORT
SMS_PROVIDER=log
# Identity inquiry: set IDENTITY_PROVIDER=sapi and the token, then re-run this script.
IDENTITY_PROVIDER=none
IDENTITY_API_TOKEN=
IDENTITY_REQUIRED=false
ENV
  chmod 600 .env
  FIRST_INSTALL=1
  echo "Created .env (keep it: it holds the database password and token secret)."
fi

# Office automation (اتوماسیون اداری): add its secrets once, also to an .env created before it existed.
if ! grep -q '^OFFICE_JWT_SECRET=' .env; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  OPORT="${OFFICE_WEB_PORT:-8100}"
  cat >> .env <<ENV
# Office automation (اتوماسیون اداری)
OFFICE_WEB_PORT=$OPORT
OFFICE_PUBLIC_URL=http://${IP:-localhost}:$OPORT
OFFICE_JWT_SECRET=$(openssl rand -hex 32)
OFFICE_DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
OFFICE_POSTGRES_PASSWORD=$(openssl rand -hex 16)
ENV
  OFFICE_FIRST_INSTALL=1
  echo "Added office automation secrets to .env."
fi
set -a; . ./.env; set +a

docker compose up --build -d

echo "Waiting for the API..."
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:${WEB_PORT}/health" >/dev/null && break
  sleep 2
done
curl -fs "http://127.0.0.1:${WEB_PORT}/health" >/dev/null || { docker compose logs --tail 50 api; exit 1; }

ADMIN_FILE=admin-password.txt
if [ "${FIRST_INSTALL:-0}" = "1" ] && [ "${SEED:-0}" = "1" ]; then
  docker compose exec -T -e ALLOW_DEMO_SEED=1 api node dist/db/seed.js
elif [ "${FIRST_INSTALL:-0}" = "1" ]; then
  # Random password, kept only in a file readable by this user (never printed or put in the container environment).
  (umask 077; openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 > "$ADMIN_FILE")
  docker compose exec -T -e ADMIN_EMAIL="${ADMIN_EMAIL:-root@kx.local}" api node dist/db/create-admin.js < "$ADMIN_FILE"
fi

OFFICE_ADMIN_FILE=office-admin-password.txt
if [ "${OFFICE_FIRST_INSTALL:-0}" = "1" ]; then
  echo "Waiting for office automation..."
  for _ in $(seq 1 60); do
    curl -fs "http://127.0.0.1:${OFFICE_WEB_PORT}/health" >/dev/null && break
    sleep 2
  done
  if [ "${OFFICE_SEED:-0}" = "1" ]; then
    docker compose exec -T -e ALLOW_DEMO_SEED=1 office-api node dist/db/seed.js
  else
    # Random password, kept only in a file readable by this user (never printed or put in the container environment).
    (umask 077; openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 > "$OFFICE_ADMIN_FILE")
    docker compose exec -T -e ADMIN_USERNAME="${OFFICE_ADMIN_USERNAME:-admin}" office-api node dist/db/create-admin.js < "$OFFICE_ADMIN_FILE"
  fi
  # Connect office automation to the meetings system (API key + signed webhooks); needs a chamber admin of the
  # meetings system: the demo one when its demo data was loaded, otherwise MEETINGS_ADMIN_EMAIL / MEETINGS_ADMIN_PASSWORD.
  if [ "${SEED:-0}" = "1" ]; then
    MEETINGS_ADMIN_EMAIL="${MEETINGS_ADMIN_EMAIL:-admin@kx.local}"
    MEETINGS_ADMIN_PASSWORD="${MEETINGS_ADMIN_PASSWORD:-Passw0rd!}"
  fi
  if [ -n "${MEETINGS_ADMIN_EMAIL:-}" ] && [ -n "${MEETINGS_ADMIN_PASSWORD:-}" ]; then
    docker compose exec -T -e MEETINGS_URL=http://api:4000 \
      -e MEETINGS_ADMIN_EMAIL="$MEETINGS_ADMIN_EMAIL" -e MEETINGS_ADMIN_PASSWORD="$MEETINGS_ADMIN_PASSWORD" \
      -e OFFICE_WEBHOOK_URL=http://office-api:4100/api/integrations/meetings/webhook office-api node dist/db/connect-meetings.js \
      || echo "Could not connect to the meetings system automatically; connect it from the office automation «یکپارچه‌سازی» page."
  else
    echo "Connect office automation to the meetings system later, from its «یکپارچه‌سازی» page (after the chamber exists)."
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Ready:  http://${IP:-localhost}:${WEB_PORT}"
if [ "${SEED:-0}" = "1" ]; then
  echo "Demo login: admin@kx.local / Passw0rd!   (also chair@, secretary@, member1@kx.local — trial only)"
elif [ "${FIRST_INSTALL:-0}" = "1" ]; then
  echo "Super admin: ${ADMIN_EMAIL:-root@kx.local} — password in $(pwd)/$ADMIN_FILE. Sign in, change it, delete the file, then create the chamber and its administrators."
fi
echo "Office automation: http://${IP:-localhost}:${OFFICE_WEB_PORT:-8100}"
if [ "${OFFICE_SEED:-0}" = "1" ]; then
  echo "  demo accounts: admin, clerk, cmshead, expert … / Passw0rd!  (trial only: change or remove before real use)"
elif [ "${OFFICE_FIRST_INSTALL:-0}" = "1" ]; then
  echo "  administrator: ${OFFICE_ADMIN_USERNAME:-admin} — password in $(pwd)/$OFFICE_ADMIN_FILE. Change it after signing in, then delete the file."
fi
echo "Logs:   docker compose logs -f api"
