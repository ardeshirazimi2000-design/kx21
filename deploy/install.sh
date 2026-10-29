#!/usr/bin/env bash
# One-shot installer / updater for the telehealth server on a fresh Linux VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/ardeshirazimi2000-design/kx21/claude/telehealth-mvp/deploy/install.sh | bash
#   curl -fsSL .../deploy/install.sh | DOMAIN=clinic.example.ir EMAIL=you@example.ir bash   # + HTTPS
#   ... | DOMAIN=clinic.example.ir BEHIND_PROXY=1 bash   # HTTPS handled by a web server already on this host
#
# Re-running it updates the code and restarts the service; data and secrets are kept.
# Supports RHEL/Alma/Rocky/CentOS Stream/Fedora (dnf/yum) and Debian/Ubuntu (apt).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ardeshirazimi2000-design/kx21.git}"
BRANCH="${BRANCH:-claude/telehealth-mvp}"
APP_DIR=/opt/kx21
DATA_DIR=/var/lib/kx21
ENV_FILE=/etc/kx21.env
NODE_VERSION="${NODE_VERSION:-22.20.0}"
NODE_DIR=/opt/node22
PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
BEHIND_PROXY="${BEHIND_PROXY:-0}"   # 1 = an existing web server (nginx/Caddy/Docker proxy) already proxies DOMAIN to this app
APP_BIND="${APP_BIND:-}"           # with a Docker proxy: the Docker bridge address, e.g. 172.17.0.1
EMAIL="${EMAIL:-}"
ENABLE_TURN="${ENABLE_TURN:-1}"   # coturn relay for video visits (needed behind mobile-carrier NAT)
ENABLE_CXR="${ENABLE_CXR:-1}"     # chest X-ray pattern flags for physicians (Python + onnxruntime, CPU, ~400 MB RAM)
CXR_PORT=8601
CXR_VENV=/opt/kx21-cxr

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -m)" = "x86_64" ] || die "only x86_64 is supported by this script"

# ---------------------------------------------------------------- HTTPS pre-flight
# The server may already host other websites. Never take ports 80/443 from another web server and
# never overwrite a Caddyfile that serves other sites: stop here, before anything is changed.
if [ -n "$DOMAIN" ] && [ "$BEHIND_PROXY" != "1" ]; then
  if command -v ss >/dev/null; then
    OTHER=$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v '"caddy"' | grep -o '(("[^"]*"' | tr -d '("' | sort -u | tr '\n' ' ' || true)
    [ -z "$OTHER" ] || die "ports 80/443 are already used by: $OTHER(another website on this server).
   Nothing was changed. Point that web server at this app instead (for nginx see
   $APP_DIR/deploy/nginx.conf.example or the repository's deploy/nginx.conf.example),
   then re-run with DOMAIN=$DOMAIN BEHIND_PROXY=1"
  fi
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q 'managed by kx21' /etc/caddy/Caddyfile; then
    SITES=$(grep -cE '^[^[:space:]#{][^{]*\{[[:space:]]*$' /etc/caddy/Caddyfile || true)
    if [ "$SITES" -gt 1 ] || ! grep -q "reverse_proxy 127.0.0.1:$PORT" /etc/caddy/Caddyfile; then
      die "/etc/caddy/Caddyfile serves other sites. Nothing was changed. Add this block to it yourself and reload Caddy:
   $DOMAIN {
       encode gzip
       reverse_proxy 127.0.0.1:$PORT {
           flush_interval -1
       }
   }
   then re-run with DOMAIN=$DOMAIN BEHIND_PROXY=1"
    fi
  fi
fi
command -v systemctl >/dev/null || die "systemd is required"

# ---------------------------------------------------------------- packages
say "Installing base packages (git, curl, tar)"
if command -v dnf >/dev/null; then PM="dnf -y -q install"
elif command -v yum >/dev/null; then PM="yum -y -q install"
elif command -v apt-get >/dev/null; then apt-get update -qq; PM="apt-get -y -qq install"
else die "unsupported distribution (need dnf, yum or apt)"; fi
$PM git curl tar xz ca-certificates >/dev/null 2>&1 || $PM git curl tar xz-utils ca-certificates >/dev/null

# Lab-sheet reading (OCR) runs on this server: Tesseract (English model), ImageMagick for photo
# clean-up, poppler for PDFs. Optional — without them the app asks for manual entry.
say "Installing OCR tools (tesseract, imagemagick, poppler)"
if command -v apt-get >/dev/null; then
  $PM tesseract-ocr tesseract-ocr-eng imagemagick poppler-utils >/dev/null 2>&1 || echo "   WARNING: OCR tools not installed; lab values must be typed in"
else
  $PM epel-release >/dev/null 2>&1 || true
  $PM tesseract tesseract-langpack-eng ImageMagick poppler-utils >/dev/null 2>&1 \
    || $PM tesseract ImageMagick poppler-utils >/dev/null 2>&1 || echo "   WARNING: OCR tools not installed; lab values must be typed in"
fi
command -v tesseract >/dev/null && echo "   $(tesseract --version 2>&1 | head -1)"

# glibc >= 2.28 is required by Node 22 (CentOS 7 is too old).
GLIBC=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)
awk -v v="$GLIBC" 'BEGIN { exit !(v >= 2.28) }' || die "glibc $GLIBC is too old for Node 22; use AlmaLinux/Rocky 8+, Debian 10+ or Ubuntu 20.04+"

# ---------------------------------------------------------------- node 22
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" -v)" != "v$NODE_VERSION" ]; then
  say "Installing Node.js $NODE_VERSION"
  TARBALL="node-v$NODE_VERSION-linux-x64.tar.xz"
  TMP=$(mktemp -d)
  for MIRROR in "https://nodejs.org/dist" "https://registry.npmmirror.com/-/binary/node" "https://mirrors.cloud.tencent.com/nodejs-release"; do
    if curl -fsSL --connect-timeout 15 --max-time 600 -o "$TMP/$TARBALL" "$MIRROR/v$NODE_VERSION/$TARBALL"; then break; fi
    echo "   mirror $MIRROR failed, trying next…"
  done
  [ -s "$TMP/$TARBALL" ] || die "could not download Node.js"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/$TARBALL" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi
ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
echo "   node $("$NODE_DIR/bin/node" -v)"

# ---------------------------------------------------------------- user + code
id kx21 >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin kx21
mkdir -p "$DATA_DIR" && chown kx21:kx21 "$DATA_DIR" && chmod 700 "$DATA_DIR"

say "Fetching code ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
echo "   commit $(git -C "$APP_DIR" rev-parse --short HEAD)"

# ---------------------------------------------------------------- config
systemctl stop kx21 2>/dev/null || true
[ -f "$ENV_FILE" ] && PORT=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || echo "$PORT")
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
  command -v ss >/dev/null && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
}
if port_busy "$PORT"; then
  OLD=$PORT
  for P in 8090 8091 8092 8093 8094 8095 8096 8097 8098 8099 9090 9191; do port_busy "$P" || { PORT=$P; break; }; done
  [ "$PORT" != "$OLD" ] || die "no free port found; set PORT=... and re-run"
  echo "   port $OLD is used by another program -> using port $PORT"
fi
if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE (secrets generated once, keep this file)"
  cat > "$ENV_FILE" <<EOF
# Telehealth server settings. Edit, then: systemctl restart kx21
# NODE_ENV=development shows OTP codes on screen because no SMS provider is connected yet.
# This is a TEST deployment: do not enter real patient data until SMS + production mode are set.
NODE_ENV=development
MASTER_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
HOST=0.0.0.0
PORT=$PORT
DB_PATH=$DATA_DIR/telehealth.db
LOG_NOTIFICATIONS=false
EOF
  chmod 600 "$ENV_FILE"
fi
sed -i "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"
# Optional integrations passed on the command line are stored in the env file, e.g.
#   curl … | SAPI_TOKEN=… ZARINPAL_MERCHANT_ID=… bash
upsert() { sed -i "/^$1=/d" "$ENV_FILE"; printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }
for VAR in SAPI_TOKEN SAPI_BASE IDENTITY_INQUIRY_URL SMS_PROVIDER SMS_API_KEY SMS_OTP_TEMPLATE SMS_MFA_TEMPLATE SMS_TEMPLATE_PARAM SMS_SENDER SMS_APIIR_SERVICE ADMIN_PHONE ADMIN_TAKEOVER DRUG_API_BASE DRUG_API_TOKEN ZARINPAL_MERCHANT_ID ZARINPAL_SANDBOX PUBLIC_BASE_URL VISION_LLM_BASE_URL VISION_LLM_MODEL LLM_BASE_URL LLM_MODEL WORKERS; do
  VAL="${!VAR:-}"; [ -n "$VAL" ] && upsert "$VAR" "$VAL" && echo "   set $VAR"
done
[ -n "$DOMAIN" ] && upsert PUBLIC_BASE_URL "https://$DOMAIN"
# Real registration (PRODUCTION=1): codes only by SMS, Shahkar required, demo accounts disabled.
envget() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -1 | cut -d= -f2-; }
if [ "${PRODUCTION:-}" = "1" ]; then
  # The api.ir token (already used for Shahkar) can send the codes too: default to it.
  if [ -z "$(envget SMS_PROVIDER)" ] && [ -n "$(envget SAPI_TOKEN)" ]; then upsert SMS_PROVIDER apiir; echo "   SMS_PROVIDER=apiir (codes via api.ir with the existing SAPI_TOKEN)"; fi
  MISSING=""
  NEED="SMS_PROVIDER ADMIN_PHONE SAPI_TOKEN"; [ "$(envget SMS_PROVIDER)" = "apiir" ] || NEED="$NEED SMS_API_KEY SMS_OTP_TEMPLATE"
  for V in $NEED; do [ -n "$(envget $V)" ] || MISSING="$MISSING $V"; done
  [ -z "$MISSING" ] || die "PRODUCTION=1 needs:$MISSING (pass them on the command line once; they are kept in $ENV_FILE)"
  upsert NODE_ENV production
  sed -i '/^SEED=/d' "$ENV_FILE"
  [ -n "$(envget ZARINPAL_MERCHANT_ID)" ] || echo "   NOTE: no ZARINPAL_MERCHANT_ID — keep patient payments switched off in the admin tariffs page"
  echo "   production mode: OTP by SMS ($(envget SMS_PROVIDER)), admin $(envget ADMIN_PHONE)"
elif [ "${PRODUCTION:-}" = "0" ]; then
  upsert NODE_ENV development
  echo "   development (test) mode: codes shown on screen"
fi
# Behind Caddy only localhost may reach the app; without a domain it listens publicly.
if [ -n "$DOMAIN" ]; then BIND=127.0.0.1; else BIND=0.0.0.0; fi
# A proxy running in Docker cannot reach 127.0.0.1 on the host: APP_BIND=172.17.0.1 (the Docker bridge)
# makes the app listen there instead (still not reachable from the internet) and trusts that proxy's
# X-Forwarded-For.
[ -n "$APP_BIND" ] || APP_BIND="$(envget APP_BIND)"   # remembered from an earlier run
if [ "$APP_BIND" = "0" ] || [ -z "$DOMAIN" ]; then sed -i '/^APP_BIND=/d; /^TRUSTED_PROXIES=/d' "$ENV_FILE"; APP_BIND=""; fi
if [ -n "$APP_BIND" ]; then BIND="$APP_BIND"; upsert APP_BIND "$APP_BIND"; upsert TRUSTED_PROXIES "${APP_BIND%%.*}."; fi
sed -i "s/^HOST=.*/HOST=$BIND/" "$ENV_FILE"

# ---------------------------------------------------------------- TURN relay (video visits)
# The address clients reach this server on. Outgoing traffic may leave through a different (NAT)
# address, so prefer: PUBLIC_IP given on the command line or saved earlier > the domain's A record
# > what an outside service sees.
PUBLIC_IP="${PUBLIC_IP:-$(envget PUBLIC_IP)}"
[ -z "$PUBLIC_IP" ] && [ -n "$DOMAIN" ] && PUBLIC_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
[ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
upsert PUBLIC_IP "$PUBLIC_IP"
if [ "$ENABLE_TURN" = "1" ]; then
  say "Setting up TURN relay (coturn) for video visits"
  if ! command -v turnserver >/dev/null; then
    if command -v dnf >/dev/null || command -v yum >/dev/null; then
      $PM epel-release >/dev/null 2>&1 || true
    fi
    $PM coturn >/dev/null 2>&1 || echo "   WARNING: could not install coturn; video calls may fail behind mobile NAT"
  fi
  if command -v turnserver >/dev/null; then
    grep -q '^TURN_SECRET=' "$ENV_FILE" || echo "TURN_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')" >> "$ENV_FILE"
    TURN_SECRET=$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2)
    sed -i '/^TURN_URLS=/d' "$ENV_FILE"
    echo "TURN_URLS=turn:$PUBLIC_IP:3478?transport=udp,turn:$PUBLIC_IP:3478?transport=tcp" >> "$ENV_FILE"
    CONF=/etc/turnserver.conf; [ -d /etc/coturn ] && CONF=/etc/coturn/turnserver.conf
    TURN_MANAGED=0
    if [ ! -f "$CONF" ] || grep -q 'managed by kx21' "$CONF"; then
      TURN_MANAGED=1
      cat > "$CONF" <<EOF
# managed by kx21 installer — re-running the installer rewrites this file
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=kx21
external-ip=$PUBLIC_IP
min-port=49160
max-port=49200
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
EOF
      chmod 640 "$CONF"; for g in coturn turnserver; do getent group $g >/dev/null && chgrp $g "$CONF" && break; done
      [ -f /etc/default/coturn ] && sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
    elif grep -q '^use-auth-secret' "$CONF" && grep -q '^static-auth-secret=' "$CONF"; then
      # A coturn already set up by something else on this server: leave it untouched and share its
      # secret, so video visits can use it too.
      upsert TURN_SECRET "$(grep '^static-auth-secret=' "$CONF" | head -1 | cut -d= -f2-)"
      P=$(grep -E '^listening-port=' "$CONF" | head -1 | cut -d= -f2); P=${P:-3478}
      sed -i '/^TURN_URLS=/d' "$ENV_FILE"
      echo "TURN_URLS=turn:$PUBLIC_IP:$P?transport=udp,turn:$PUBLIC_IP:$P?transport=tcp" >> "$ENV_FILE"
      echo "   using the existing coturn ($CONF, port $P) and its secret; its configuration was not changed"
    else
      echo "   WARNING: $CONF is not managed by this installer and has no use-auth-secret/static-auth-secret;"
      echo "            video relay will not authenticate. Add those two lines to it (see README) or remove it."
    fi
    if [ "$TURN_MANAGED" = "1" ]; then
      systemctl enable -q coturn 2>/dev/null || true
      systemctl restart coturn 2>/dev/null || echo "   WARNING: coturn did not start (journalctl -u coturn)"
    fi
    TURN_OK=1
  fi
fi

# ---------------------------------------------------------------- chest X-ray aid (optional)
if [ "$ENABLE_CXR" = "1" ]; then
  say "Setting up chest X-ray pattern service (research aid for physicians)"
  CXR_OK=0
  if command -v apt-get >/dev/null; then $PM python3 python3-venv python3-pip >/dev/null 2>&1 || true
  else $PM python3 python3-pip >/dev/null 2>&1 || true; fi
  if command -v python3 >/dev/null && { [ -x "$CXR_VENV/bin/python" ] || python3 -m venv "$CXR_VENV" >/dev/null 2>&1; }; then
    "$CXR_VENV/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
    if "$CXR_VENV/bin/pip" install -q onnxruntime numpy pillow >/dev/null 2>&1; then
      cat > /etc/systemd/system/kx21-cxr.service <<UNIT
[Unit]
Description=kx21 chest X-ray pattern service (local only)
After=network.target

[Service]
User=kx21
Group=kx21
WorkingDirectory=$APP_DIR/cxr
Environment=CXR_PORT=$CXR_PORT
Environment=CXR_THREADS=2
ExecStart=$CXR_VENV/bin/python $APP_DIR/cxr/cxr_service.py
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable -q kx21-cxr
      systemctl restart kx21-cxr
      for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$CXR_PORT/health" >/dev/null 2>&1 && { CXR_OK=1; break; }; sleep 1; done
    fi
  fi
  if [ "$CXR_OK" = "1" ]; then upsert CXR_URL "http://127.0.0.1:$CXR_PORT"; echo "   chest X-ray service is running"
  else sed -i '/^CXR_URL=/d' "$ENV_FILE"; echo "   WARNING: chest X-ray service not available (python3/onnxruntime); the app works without it"; fi
else
  systemctl disable --now kx21-cxr 2>/dev/null || true
  sed -i '/^CXR_URL=/d' "$ENV_FILE"
fi

# ---------------------------------------------------------------- service
say "Installing systemd service kx21"
# Behind a proxy in Docker the app listens on the Docker bridge, which exists only once Docker is up.
DOCKER_AFTER=""; if [ -n "$APP_BIND" ] && systemctl list-unit-files docker.service >/dev/null 2>&1; then DOCKER_AFTER=" docker.service"; fi
cat > /etc/systemd/system/kx21.service <<EOF
[Unit]
Description=Telehealth clinic server (kx21)
After=network-online.target$DOCKER_AFTER
Wants=network-online.target
# Keep retrying after a reboot until the network it listens on (e.g. the Docker bridge) exists.
StartLimitIntervalSec=0

[Service]
User=kx21
Group=kx21
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_DIR/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q kx21
systemctl restart kx21

# ---------------------------------------------------------------- HTTPS (optional)
if [ -n "$DOMAIN" ] && [ "$BEHIND_PROXY" != "1" ]; then
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy (automatic HTTPS)"
    curl -fsSL --max-time 300 -o /usr/local/bin/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64" \
      || die "could not download Caddy"
    chmod +x /usr/local/bin/caddy
    id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
  fi
  mkdir -p /etc/caddy
  cat > /etc/caddy/Caddyfile <<EOF
# managed by kx21 installer (re-running it rewrites this file)
{
	${EMAIL:+email $EMAIL}
}
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
  cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy reverse proxy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q caddy
  systemctl restart caddy
fi

# ---------------------------------------------------------------- firewall
open_port() {
  if systemctl is-active -q firewalld 2>/dev/null; then firewall-cmd -q --permanent --add-port="$1/tcp"; firewall-cmd -q --reload
  elif command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$1/tcp" >/dev/null; fi
}
if [ -n "$DOMAIN" ]; then [ "$BEHIND_PROXY" = "1" ] || { open_port 80; open_port 443; }; else open_port "$PORT"; fi
if [ "${TURN_OK:-0}" = "1" ]; then
  if systemctl is-active -q firewalld 2>/dev/null; then
    firewall-cmd -q --permanent --add-port=3478/udp --add-port=3478/tcp --add-port=49160-49200/udp; firewall-cmd -q --reload
  elif command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 3478 >/dev/null; ufw allow 49160:49200/udp >/dev/null
  fi
fi

# ---------------------------------------------------------------- check
sleep 2
CHECK_HOST=127.0.0.1; [ "$BIND" = "0.0.0.0" ] || CHECK_HOST="$BIND"
if curl -fsS "http://$CHECK_HOST:$PORT/healthz" >/dev/null; then
  IP=$PUBLIC_IP
  say "Done ✔"
  if [ -n "$DOMAIN" ]; then echo "   Open: https://$DOMAIN   (DNS A record of $DOMAIN must point to $IP)"
  else echo "   Open: http://$IP:$PORT"; fi
  echo "   Logs: journalctl -u kx21 -f     Update: re-run this command"
  [ "${TURN_OK:-0}" = "1" ] && echo "   Video relay (TURN): $PUBLIC_IP:3478 — also open 3478/udp+tcp and 49160-49200/udp in your hosting panel firewall"
else
  journalctl -u kx21 -n 30 --no-pager
  die "service did not start (see log above)"
fi
