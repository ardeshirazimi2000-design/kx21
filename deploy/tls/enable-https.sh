#!/usr/bin/env bash
# Turns on HTTPS for a Docker install of the commissions system (docs/11-https.md):
#
#   bash deploy/tls/enable-https.sh [name-or-address ...]
#
# Without a certificate from a public authority it makes an internal one (deploy/tls/make-cert.sh) in KX_TLS_DIR
# (default /root/kx21-tls, outside the repository); to use a real certificate instead, put its fullchain.pem and
# privkey.pem there first. Then HTTPS listens on HTTPS_PORT (default 8443), the HTTP port only redirects, and sign-in
# over plain HTTP is refused. Data are not touched; run `git pull` and this again after updates if needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "No .env here: install first (bash deploy/docker-install.sh)." >&2; exit 1; }
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
get_env() { grep "^$1=" .env | tail -1 | cut -d= -f2- || true; }

TLS_DIR="$(get_env KX_TLS_DIR)"; TLS_DIR="${TLS_DIR:-${KX_TLS_DIR:-/root/kx21-tls}}"
PORT="$(get_env HTTPS_PORT)"; PORT="${PORT:-${HTTPS_PORT:-8443}}"
if command -v ss >/dev/null && ss -ltn "sport = :$PORT" | grep -q LISTEN && ! docker compose ps web --format '{{.Ports}}' 2>/dev/null | grep -q ":$PORT->"; then
  echo "Port $PORT is in use by another service; choose another: HTTPS_PORT=9443 bash $0" >&2; exit 1
fi
if [ ! -s "$TLS_DIR/fullchain.pem" ] || [ ! -s "$TLS_DIR/privkey.pem" ]; then
  bash deploy/tls/make-cert.sh "$TLS_DIR" "$@"
fi

set_env KX_TLS_DIR "$TLS_DIR"
set_env HTTPS_PORT "$PORT"
FILES="$(get_env COMPOSE_FILE)"; FILES="${FILES:-docker-compose.yml}"
case ":$FILES:" in *:docker-compose.tls.yml:*) ;; *) FILES="$FILES:docker-compose.tls.yml" ;; esac
set_env COMPOSE_FILE "$FILES"
# Browsers on the HTTPS address may call the API.
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ORIGINS="$(get_env CORS_ORIGINS)"
for o in "https://${IP:-localhost}:$PORT" "https://localhost:$PORT"; do
  case ",$ORIGINS," in *",$o,"*) ;; *) ORIGINS="${ORIGINS:+$ORIGINS,}$o" ;; esac
done
set_env CORS_ORIGINS "$ORIGINS"

docker compose up -d web api
echo
echo "HTTPS:  https://${IP:-localhost}:$PORT   (http://…:$(get_env WEB_PORT) now redirects there)"
[ -s "$TLS_DIR/kx21-ca.crt" ] && echo "Internal certificate: give $TLS_DIR/kx21-ca.crt to users to install once (see docs/11-https.md)."
