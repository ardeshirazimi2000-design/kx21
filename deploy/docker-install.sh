#!/usr/bin/env bash
# Trial install with Docker:  bash deploy/docker-install.sh
# Creates .env with random secrets (once), builds and starts the stack on $WEB_PORT (default 8000)
# and loads demo data on first install (SEED=0 to skip).
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
# Office automation (اتوماسیون اداری)
OFFICE_WEB_PORT=${OFFICE_WEB_PORT:-8100}
OFFICE_PUBLIC_URL=http://${IP:-localhost}:${OFFICE_WEB_PORT:-8100}
OFFICE_JWT_SECRET=$(openssl rand -hex 32)
OFFICE_DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
OFFICE_POSTGRES_PASSWORD=$(openssl rand -hex 16)
ENV
  chmod 600 .env
  FIRST_INSTALL=1
  echo "Created .env (keep it: it holds the database password and token secret)."
fi
set -a; . ./.env; set +a

docker compose up --build -d

echo "Waiting for the API..."
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:${WEB_PORT}/health" >/dev/null && break
  sleep 2
done
curl -fs "http://127.0.0.1:${WEB_PORT}/health" >/dev/null || { docker compose logs --tail 50 api; exit 1; }

if [ "${FIRST_INSTALL:-0}" = "1" ] && [ "${SEED:-1}" = "1" ]; then
  docker compose exec -T api node dist/db/seed.js
  docker compose exec -T office-api node dist/db/seed.js
  # Connect office automation to the meetings system (API key + signed webhooks).
  docker compose exec -T -e MEETINGS_URL=http://api:4000 -e MEETINGS_ADMIN_EMAIL=admin@kx.local -e MEETINGS_ADMIN_PASSWORD='Passw0rd!' \
    -e OFFICE_WEBHOOK_URL=http://office-api:4100/api/integrations/meetings/webhook office-api node dist/db/connect-meetings.js
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Ready:  http://${IP:-localhost}:${WEB_PORT}"
echo "Demo login: admin@kx.local / Passw0rd!   (also chair@, secretary@, member1@kx.local)"
echo "Office automation: http://${IP:-localhost}:${OFFICE_WEB_PORT:-8100}   (admin, clerk, cmshead, expert … / Passw0rd!)"
echo "Logs:   docker compose logs -f api"
