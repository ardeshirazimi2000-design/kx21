#!/usr/bin/env bash
# Tests the office-web nginx site (apps/office-web/nginx/40-office-site.sh) in the real nginx image, HTTP and HTTPS,
# against a stub API that echoes the forwarded headers; then checks the Docker Compose port and HTTPS settings.
# Needs Docker. Throwaway certificates are made in a temporary folder and deleted at the end.
#   bash apps/office-web/test/nginx-site.test.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="$PWD"
NGINX_IMAGE=nginx:1.27-alpine
NODE_IMAGE=node:22-alpine
ID="officeweb-test-$$"
NET="$ID-net"
TMP="$(mktemp -d)"
FAILED=0
CONTAINERS=()

cleanup() {
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILED=1; }
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi
}
has() { grep -qi -- "$1" <<<"$2"; }

# ── fixtures: static site, throwaway CA and server certificate (P-256), stub API ──
mkdir -p "$TMP/html/assets" "$TMP/tls" "$TMP/stub"
echo '<!doctype html><title>office</title>' > "$TMP/html/index.html"
echo 'console.log(1)' > "$TMP/html/assets/app.js"
openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/ca.key" 2>/dev/null
openssl req -x509 -new -key "$TMP/ca.key" -subj "/CN=office test CA" -days 2 -out "$TMP/ca.crt" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/tls/privkey.pem" 2>/dev/null
openssl req -new -key "$TMP/tls/privkey.pem" -subj "/CN=localhost" -out "$TMP/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$TMP/ext.cnf"
openssl x509 -req -in "$TMP/server.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial -days 2 -extfile "$TMP/ext.cnf" -out "$TMP/server.crt" 2>/dev/null
cat "$TMP/server.crt" "$TMP/ca.crt" > "$TMP/tls/fullchain.pem"
chmod 644 "$TMP/tls/"* "$TMP/html/index.html" "$TMP/html/assets/app.js"
cat > "$TMP/stub/echo.js" <<'JS'
require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-frame-options', 'SAMEORIGIN'); // as helmet in office-api does
  res.setHeader('strict-transport-security', 'max-age=1');
  res.end(JSON.stringify({ path: req.url, xff: req.headers['x-forwarded-for'] ?? null, proto: req.headers['x-forwarded-proto'] ?? null }));
}).listen(4100);
JS

docker network create "$NET" >/dev/null
GATEWAY="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NET")"
CONTAINERS+=("$ID-api")
docker run -d --name "$ID-api" --network "$NET" --network-alias office-api -v "$TMP/stub:/stub:ro" "$NODE_IMAGE" node /stub/echo.js >/dev/null

# start_web <name> [docker -e options...] → runs the site; prints nothing, sets HTTP_PORT / HTTPS_PORT
start_web() {
  local name="$ID-$1"; shift
  CONTAINERS+=("$name")
  docker run -d --name "$name" --network "$NET" -p 127.0.0.1::80 -p 127.0.0.1::443 \
    -v "$REPO/apps/office-web/nginx/40-office-site.sh:/docker-entrypoint.d/40-office-site.sh:ro" \
    -v "$TMP/html:/usr/share/nginx/html:ro" "$@" "$NGINX_IMAGE" >/dev/null
  for _ in $(seq 1 40); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then return 1; fi
    if curl -fs -o /dev/null "http://127.0.0.1:$(docker port "$name" 80/tcp | head -1 | cut -d: -f2)/health"; then
      HTTP_PORT="$(docker port "$name" 80/tcp | head -1 | cut -d: -f2)"
      HTTPS_PORT="$(docker port "$name" 443/tcp | head -1 | cut -d: -f2)"
      return 0
    fi
    sleep 0.25
  done
  return 1
}
# refuses <name> <expected log text> [docker -e options...] → the container must stop with that message
refuses() {
  local name="$ID-$1" text="$2"; shift 2
  CONTAINERS+=("$name")
  docker run -d --name "$name" -v "$REPO/apps/office-web/nginx/40-office-site.sh:/docker-entrypoint.d/40-office-site.sh:ro" "$@" "$NGINX_IMAGE" >/dev/null
  for _ in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = false ] && break
    sleep 0.25
  done
  [ "$(docker inspect -f '{{.State.Running}}:{{.State.ExitCode}}' "$name")" != "false:0" ] && docker logs "$name" 2>&1 | grep -q -- "$text"
}
SPOOF=(-H 'X-Forwarded-For: 203.0.113.9' -H 'X-Forwarded-Proto: https')

echo "HTTP (default, as existing installs)"
start_web http || { docker logs "$ID-http"; exit 1; }
H="$(curl -sS -D - -o /dev/null "http://127.0.0.1:$HTTP_PORT/")"
check "page is served" has "200" "$H"
check "nosniff, X-Frame-Options and Referrer-Policy" bash -c "grep -qi 'x-content-type-options: nosniff' <<<\"$H\" && grep -qi 'x-frame-options: deny' <<<\"$H\" && grep -qi 'referrer-policy' <<<\"$H\""
check "CSP is report-only" has "content-security-policy-report-only: default-src 'self'" "$H"
check "no enforcing CSP yet" bash -c "! grep -qi '^content-security-policy:' <<<\"$H\""
check "no HSTS over plain HTTP" bash -c "! grep -qi strict-transport-security <<<\"$H\""
A="$(curl -sS -D - -o /dev/null "http://127.0.0.1:$HTTP_PORT/assets/app.js")"
check "assets keep the security headers (nginx add_header inheritance)" bash -c "grep -qi 'x-content-type-options: nosniff' <<<\"$A\" && grep -qi 'content-security-policy-report-only' <<<\"$A\" && grep -qi immutable <<<\"$A\""
E="$(curl -sS "${SPOOF[@]}" "http://127.0.0.1:$HTTP_PORT/api/echo")"
check "client-sent X-Forwarded-For is replaced by the real peer ($GATEWAY)" has "\"xff\":\"$GATEWAY\"" "$E"
check "client-sent X-Forwarded-Proto: https is ignored" has '"proto":"http"' "$E"

A="$(curl -sS -D - -o /dev/null "http://127.0.0.1:$HTTP_PORT/api/echo")"
check "API responses carry one X-Frame-Options (DENY) and no HSTS from the API over HTTP" bash -c "[ \"\$(grep -ci '^x-frame-options:' <<<\"$A\")\" = 1 ] && grep -qi 'x-frame-options: deny' <<<\"$A\" && ! grep -qi strict-transport-security <<<\"$A\""

echo "HTTP behind a trusted reverse proxy (OFFICE_TRUSTED_PROXIES=$GATEWAY)"
start_web proxied -e OFFICE_TRUSTED_PROXIES="$GATEWAY" || { docker logs "$ID-proxied"; exit 1; }
E="$(curl -sS "${SPOOF[@]}" "http://127.0.0.1:$HTTP_PORT/api/echo")"
check "client address from the trusted proxy is passed on" has '"xff":"203.0.113.9"' "$E"
check "scheme from the trusted proxy is passed on" has '"proto":"https"' "$E"
H="$(curl -sS -D - -o /dev/null -H 'X-Forwarded-Proto: https' "http://127.0.0.1:$HTTP_PORT/")"
check "HSTS when the trusted proxy reports HTTPS" has "strict-transport-security: max-age=86400" "$H"
E="$(curl -sS -H 'X-Forwarded-For: 198.51.100.1, 203.0.113.9' "http://127.0.0.1:$HTTP_PORT/api/echo")"
check "an address the client prepends is not believed" has '"xff":"203.0.113.9"' "$E"

echo "HTTPS on the container (OFFICE_TLS=1)"
start_web tls -e OFFICE_TLS=1 -e OFFICE_HTTPS_PUBLIC_PORT=8443 -v "$TMP/tls:/etc/nginx/tls:ro" || { docker logs "$ID-tls"; exit 1; }
R="$(curl -sS -D - -o /dev/null -H 'Host: localhost' "http://127.0.0.1:$HTTP_PORT/letters/1?x=2")"
check "HTTP redirects (301) to HTTPS on the public port" bash -c "grep -q ' 301' <<<\"$R\" && grep -qi 'location: https://localhost:8443/letters/1?x=2' <<<\"$R\""
check "/health still answers on HTTP for local checks" curl -fsS "http://127.0.0.1:$HTTP_PORT/health"
check "API is not reachable over plain HTTP" bash -c "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$HTTP_PORT/api/echo | grep -q 301"
TLSCURL=(curl -sS --cacert "$TMP/ca.crt" --resolve "localhost:$HTTPS_PORT:127.0.0.1")
H="$("${TLSCURL[@]}" -D - -o /dev/null "https://localhost:$HTTPS_PORT/")"
check "page over HTTPS with a certificate the client verifies" has "200" "$H"
check "HSTS with the configured max-age, no includeSubDomains" bash -c "grep -qi 'strict-transport-security: max-age=86400' <<<\"$H\" && ! grep -qi includesubdomains <<<\"$H\""
E="$("${TLSCURL[@]}" -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Forwarded-Proto: http' "https://localhost:$HTTPS_PORT/api/echo")"
check "API receives proto=https and the real peer" bash -c "grep -q '\"proto\":\"https\"' <<<'$E' && grep -q '\"xff\":\"$GATEWAY\"' <<<'$E'"
sc() { echo | timeout 10 openssl s_client -connect "127.0.0.1:$HTTPS_PORT" -servername localhost "$@" 2>&1; }
check "TLS 1.2 handshake" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; sc -tls1_2 | grep -q 'Protocol *: TLSv1.2'"
check "TLS 1.1 is refused" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; ! sc -tls1_1 -cipher DEFAULT@SECLEVEL=0 | grep -q 'Cipher is ECDHE'"
check "TLS 1.0 is refused" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; ! sc -tls1 -cipher DEFAULT@SECLEVEL=0 | grep -q 'Cipher is ECDHE'"
check "a CBC/SHA1 suite outside the configured list is refused" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; ! sc -tls1_2 -cipher ECDHE-ECDSA-AES128-SHA | grep -q 'Cipher is ECDHE-ECDSA-AES128-SHA'"
# The client offers X25519 first and P-256 too (the test certificate is P-256, so P-256 must be offered for it to be usable).
check "key exchange uses an allowed NIST curve, not X25519" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; sc -tls1_2 -curves X25519:prime256v1 | grep -E 'Server Temp Key: ECDH, (prime256v1|P-256)'"
check "ECDHE-ECDSA-AES128-GCM-SHA256 is accepted" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; sc -tls1_2 -cipher ECDHE-ECDSA-AES128-GCM-SHA256 | grep -q 'Cipher is ECDHE-ECDSA-AES128-GCM-SHA256'"

check "TLS 1.3 handshake (allowed by default)" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; sc -tls1_3 | grep -q 'New, TLSv1.3'"

echo "HTTPS with HSTS off and TLS 1.2 only"
start_web nohsts -e OFFICE_TLS=1 -e OFFICE_HSTS_MAX_AGE=off -e OFFICE_TLS_PROTOCOLS=TLSv1.2 -v "$TMP/tls:/etc/nginx/tls:ro" || { docker logs "$ID-nohsts"; exit 1; }
H="$("${TLSCURL[@]}" -D - -o /dev/null "https://localhost:$HTTPS_PORT/")"
check "no HSTS header" bash -c "! grep -qi strict-transport-security <<<\"$H\""
check "TLS 1.3 refused when OFFICE_TLS_PROTOCOLS=TLSv1.2" bash -c "$(declare -f sc); HTTPS_PORT=$HTTPS_PORT; ! sc -tls1_3 | grep -q 'New, TLSv1.3'"

echo "Bad settings stop the container instead of serving plain HTTP"
check "HTTPS without a certificate" refuses nocert "certificate" -e OFFICE_TLS=1
check "a trusted proxy that is not an address" refuses badproxy "not an address" -e "OFFICE_TRUSTED_PROXIES=10.0.0.1; evil"
check "TLS 1.1 in OFFICE_TLS_PROTOCOLS" refuses oldtls "only TLSv1.2 and TLSv1.3" -e OFFICE_TLS=1 -e "OFFICE_TLS_PROTOCOLS=TLSv1.1 TLSv1.2"
check "an unknown CSP mode" refuses badcsp "OFFICE_CSP_MODE" -e OFFICE_CSP_MODE=sometimes

echo "Docker Compose"
compose() { OFFICE_JWT_SECRET=x OFFICE_DATA_ENCRYPTION_KEY=y JWT_SECRET=z docker compose -f "$REPO/docker-compose.yml" "$@" config --format json 2>&1; }
ports() { python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['services']['office-web']['ports'], sort_keys=True))"; }
apienv() { python3 -c "import json,sys; d=json.load(sys.stdin); e=d['services']['office-api']['environment']; print(e.get('TRUST_PROXY'), e.get('PUBLIC_HTTPS'))"; }
D="$(compose)"
check "default: office-web published on 8100 on all interfaces, exactly as before" bash -c "grep -q '\"published\": \"8100\"' <<<'$(ports <<<"$D")' && ! grep -q host_ip <<<'$(ports <<<"$D")'"
check "default: the API trusts one hop (the office-web nginx), PUBLIC_HTTPS off" bash -c "[ '$(apienv <<<"$D")' = '1 false' ]"
D="$(OFFICE_BIND=127.0.0.1 compose)"
check "OFFICE_BIND=127.0.0.1 publishes only on loopback" bash -c "grep -q '\"host_ip\": \"127.0.0.1\"' <<<'$(ports <<<"$D")'"
D="$(OFFICE_TLS_DIR=/srv/office-tls compose -f "$REPO/docker-compose.office-tls.yml")"
check "TLS override: 8443 (not 443) published, certificate folder read-only, PUBLIC_HTTPS on" bash -c \
  "grep -q '\"published\": \"8443\"' <<<'$(ports <<<"$D")' && ! grep -q '\"published\": \"443\"' <<<'$(ports <<<"$D")' && grep -q '/srv/office-tls' <<<'$D' && [ '$(apienv <<<"$D")' = '1 true' ]"
check "TLS override refuses to start without OFFICE_TLS_DIR" bash -c "! OFFICE_JWT_SECRET=x OFFICE_DATA_ENCRYPTION_KEY=y JWT_SECRET=z docker compose -f '$REPO/docker-compose.yml' -f '$REPO/docker-compose.office-tls.yml' config >/dev/null 2>&1"

if [ "$FAILED" = 0 ]; then echo "All office-web nginx checks passed."; else echo "Some office-web nginx checks FAILED."; exit 1; fi
