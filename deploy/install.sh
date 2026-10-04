#!/usr/bin/env bash
# One-shot installer / updater for the telehealth server on a fresh Linux VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/ardeshirazimi2000-design/kx21/claude/telehealth-mvp/deploy/install.sh | bash
#   curl -fsSL .../deploy/install.sh | DOMAIN=clinic.example.ir EMAIL=you@example.ir bash   # + HTTPS
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
EMAIL="${EMAIL:-}"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -m)" = "x86_64" ] || die "only x86_64 is supported by this script"
command -v systemctl >/dev/null || die "systemd is required"

# ---------------------------------------------------------------- packages
say "Installing base packages (git, curl, tar)"
if command -v dnf >/dev/null; then PM="dnf -y -q install"
elif command -v yum >/dev/null; then PM="yum -y -q install"
elif command -v apt-get >/dev/null; then apt-get update -qq; PM="apt-get -y -qq install"
else die "unsupported distribution (need dnf, yum or apt)"; fi
$PM git curl tar xz ca-certificates >/dev/null 2>&1 || $PM git curl tar xz-utils ca-certificates >/dev/null

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
echo "   node $(node -v)"

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
if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE (secrets generated once, keep this file)"
  BIND=0.0.0.0; [ -n "$DOMAIN" ] && BIND=127.0.0.1
  cat > "$ENV_FILE" <<EOF
# Telehealth server settings. Edit, then: systemctl restart kx21
# NODE_ENV=development shows OTP codes on screen because no SMS provider is connected yet.
# This is a TEST deployment: do not enter real patient data until SMS + production mode are set.
NODE_ENV=development
MASTER_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
HOST=$BIND
PORT=$PORT
DB_PATH=$DATA_DIR/telehealth.db
LOG_NOTIFICATIONS=false
EOF
  chmod 600 "$ENV_FILE"
fi
if [ -n "$DOMAIN" ]; then sed -i 's/^HOST=.*/HOST=127.0.0.1/' "$ENV_FILE"; fi

# ---------------------------------------------------------------- service
say "Installing systemd service kx21"
cat > /etc/systemd/system/kx21.service <<EOF
[Unit]
Description=Telehealth clinic server (kx21)
After=network-online.target
Wants=network-online.target

[Service]
User=kx21
Group=kx21
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_DIR/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
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
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null; then
    say "Installing Caddy (automatic HTTPS)"
    curl -fsSL --max-time 300 -o /usr/local/bin/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64" \
      || die "could not download Caddy"
    chmod +x /usr/local/bin/caddy
    id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
  fi
  mkdir -p /etc/caddy
  cat > /etc/caddy/Caddyfile <<EOF
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
if [ -n "$DOMAIN" ]; then open_port 80; open_port 443; else open_port "$PORT"; fi

# ---------------------------------------------------------------- check
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  say "Done ✔"
  if [ -n "$DOMAIN" ]; then echo "   Open: https://$DOMAIN   (DNS A record of $DOMAIN must point to $IP)"
  else echo "   Open: http://$IP:$PORT"; fi
  echo "   Logs: journalctl -u kx21 -f     Update: re-run this command"
else
  journalctl -u kx21 -n 30 --no-pager
  die "service did not start (see log above)"
fi
