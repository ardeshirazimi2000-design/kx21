#!/bin/sh
# Writes the commissions system's nginx site from the environment when the container starts (run by the nginx
# image's entrypoint from /docker-entrypoint.d). Every value is checked: a bad setting stops the container instead of
# silently serving plain HTTP. The same design as the office automation site (apps/office-web/nginx); see
# docs/11-https.md.
#
#   KX_TLS=1                       HTTPS on 443 with the certificate below; port 80 only redirects (and serves /health)
#   KX_TLS_CERT / KX_TLS_KEY   certificate chain and private key inside the container
#                                      (default /etc/nginx/tls/fullchain.pem and privkey.pem, mounted read-only)
#   KX_HTTPS_PUBLIC_PORT=443       port browsers use for HTTPS (the redirect target), e.g. 8443
#   KX_TLS_PROTOCOLS="TLSv1.2 TLSv1.3"
#   KX_TLS_CIPHERS                 TLS 1.2 cipher suites (OpenSSL names)
#   KX_TRUSTED_PROXIES             addresses / CIDR ranges of a reverse proxy in front (e.g. Caddy), comma separated;
#                                      only they may set X-Forwarded-For and X-Forwarded-Proto
#   KX_HSTS_MAX_AGE=86400          Strict-Transport-Security on HTTPS responses; "off" to leave it out
#   KX_HSTS_INCLUDE_SUBDOMAINS=0
#   KX_CSP_MODE=report-only        Content-Security-Policy: report-only | enforce | off
#   KX_API_UPSTREAM=api:4000
set -eu

OUT=/etc/nginx/conf.d/default.conf
TLS="${KX_TLS:-0}"
CERT="${KX_TLS_CERT:-/etc/nginx/tls/fullchain.pem}"
KEY="${KX_TLS_KEY:-/etc/nginx/tls/privkey.pem}"
HTTPS_PORT="${KX_HTTPS_PUBLIC_PORT:-443}"
PROTOCOLS="${KX_TLS_PROTOCOLS:-TLSv1.2 TLSv1.3}"
# ECDHE with AES-GCM, all from the TLS server list of the AFTA requirements (3.3).
CIPHERS="${KX_TLS_CIPHERS:-ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384}"
PROXIES="${KX_TRUSTED_PROXIES:-}"
HSTS_MAX_AGE="${KX_HSTS_MAX_AGE:-86400}"
HSTS_SUB="${KX_HSTS_INCLUDE_SUBDOMAINS:-0}"
CSP_MODE="${KX_CSP_MODE:-report-only}"
UPSTREAM="${KX_API_UPSTREAM:-api:4000}"

fail() {
  echo "kx-web: $*" >&2
  exit 1
}

case "$TLS" in 0 | 1) ;; *) fail "KX_TLS must be 0 or 1" ;; esac
case "$HTTPS_PORT" in '' | *[!0-9]*) fail "KX_HTTPS_PUBLIC_PORT must be a port number" ;; esac
case "$HSTS_MAX_AGE" in off) ;; '' | *[!0-9]*) fail "KX_HSTS_MAX_AGE must be a number of seconds or off" ;; esac
case "$HSTS_SUB" in 0 | 1) ;; *) fail "KX_HSTS_INCLUDE_SUBDOMAINS must be 0 or 1" ;; esac
case "$CSP_MODE" in report-only | enforce | off) ;; *) fail "KX_CSP_MODE must be report-only, enforce or off" ;; esac
for p in $PROTOCOLS; do
  case "$p" in TLSv1.2 | TLSv1.3) ;; *) fail "KX_TLS_PROTOCOLS: only TLSv1.2 and TLSv1.3 are allowed, not $p" ;; esac
done
echo "$CIPHERS" | grep -Eq '^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$' || fail "KX_TLS_CIPHERS must be OpenSSL cipher names separated by ':'"
echo "$UPSTREAM" | grep -Eq '^[A-Za-z0-9.-]+:[0-9]+$' || fail "KX_API_UPSTREAM must be host:port"
PROXY_LIST=$(echo "$PROXIES" | tr ',' ' ')
for p in $PROXY_LIST; do
  echo "$p" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$' || fail "KX_TRUSTED_PROXIES: \"$p\" is not an address or CIDR range"
done
if [ "$TLS" = 1 ]; then
  [ -r "$CERT" ] || fail "KX_TLS=1 but the certificate $CERT is missing or unreadable"
  [ -r "$KEY" ] || fail "KX_TLS=1 but the private key $KEY is missing or unreadable"
fi

HSTS=""
if [ "$HSTS_MAX_AGE" != off ]; then
  HSTS="max-age=$HSTS_MAX_AGE"
  if [ "$HSTS_SUB" = 1 ]; then HSTS="$HSTS; includeSubDomains"; fi
fi
# Report-only first: the meeting room (webinar, presentation viewer) and printing must be checked before enforcing.
CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
case "$CSP_MODE" in
  report-only) CSP_HEADER="add_header Content-Security-Policy-Report-Only \"$CSP\" always;" ;;
  enforce) CSP_HEADER="add_header Content-Security-Policy \"$CSP\" always;" ;;
  off) CSP_HEADER="" ;;
esac
REDIRECT_PORT=""
if [ "$HTTPS_PORT" != 443 ]; then REDIRECT_PORT=":$HTTPS_PORT"; fi

mkdir -p /etc/nginx/kx
{
  echo "add_header X-Content-Type-Options nosniff always;"
  echo "add_header X-Frame-Options DENY always;"
  echo "add_header Referrer-Policy strict-origin-when-cross-origin always;"
  echo "add_header Strict-Transport-Security \$kx_hsts always;"
  echo "$CSP_HEADER"
} > /etc/nginx/kx/headers.conf

cat > /etc/nginx/kx/proxy.conf <<EOF
proxy_set_header Host \$http_host;
# The client address and scheme as nginx established them (not as the client claims): the API trusts one hop.
proxy_set_header X-Forwarded-For \$remote_addr;
proxy_set_header X-Forwarded-Proto \$kx_forwarded_proto;
# One value for each of these headers, from headers.conf (the API sets its own too).
proxy_hide_header X-Content-Type-Options;
proxy_hide_header X-Frame-Options;
proxy_hide_header Referrer-Policy;
proxy_hide_header Strict-Transport-Security;
EOF

cat > /etc/nginx/kx/locations.conf <<EOF
root /usr/share/nginx/html;
client_max_body_size 60m;
include /etc/nginx/kx/headers.conf;

# Document uploads, including meeting recordings (MAX_RECORDING_MB, default 2 GB): streamed to the api, not buffered here.
location = /api/documents {
  client_max_body_size 2100m;
  proxy_request_buffering off;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;
  proxy_pass http://$UPSTREAM;
  include /etc/nginx/kx/proxy.conf;
}

location /api/ {
  proxy_pass http://$UPSTREAM;
  include /etc/nginx/kx/proxy.conf;
}

location /socket.io/ {
  proxy_pass http://$UPSTREAM;
  proxy_http_version 1.1;
  proxy_set_header Upgrade \$http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 1h;
  include /etc/nginx/kx/proxy.conf;
}

location = /health { proxy_pass http://$UPSTREAM; }

# PDF.js worker (ES module): older nginx builds do not map .mjs to JavaScript.
location ~* \.mjs\$ {
  default_type application/javascript;
  expires 1y;
  add_header Cache-Control "public, immutable";
  include /etc/nginx/kx/headers.conf;
}

location /assets/ {
  expires 1y;
  add_header Cache-Control "public, immutable";
  include /etc/nginx/kx/headers.conf;
}

location / {
  try_files \$uri /index.html;
}
EOF

{
  echo "# Generated by /docker-entrypoint.d/40-kx-site.sh at container start; edit the environment, not this file."
  echo
  echo "# A reverse proxy in front may report the client (X-Forwarded-For) and scheme (X-Forwarded-Proto); nobody else."
  for p in $PROXY_LIST; do echo "set_real_ip_from $p;"; done
  echo "real_ip_header X-Forwarded-For;"
  echo "real_ip_recursive on;"
  echo "geo \$realip_remote_addr \$kx_from_proxy {"
  echo "  default 0;"
  for p in $PROXY_LIST; do echo "  $p 1;"; done
  echo "}"
  echo "map \"\$kx_from_proxy:\$http_x_forwarded_proto\" \$kx_forwarded_proto {"
  echo "  default \$scheme;"
  echo "  \"~^1:(?<proto>https?)\$\" \$proto;"
  echo "}"
  echo "map \$kx_forwarded_proto \$kx_hsts {"
  echo "  default \"\";"
  if [ -n "$HSTS" ]; then echo "  https \"$HSTS\";"; fi
  echo "}"
  echo
  if [ "$TLS" = 1 ]; then
    cat <<EOF
server {
  listen 80;
  server_name _;
  location = /health { proxy_pass http://$UPSTREAM; }
  location / { return 301 https://\$host$REDIRECT_PORT\$request_uri; }
}

server {
  listen 443 ssl;
  http2 on;
  server_name _;
  ssl_certificate $CERT;
  ssl_certificate_key $KEY;
  ssl_protocols $PROTOCOLS;
  ssl_ciphers $CIPHERS;
  ssl_prefer_server_ciphers on;
  ssl_conf_command Ciphersuites TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256;
  ssl_ecdh_curve secp256r1:secp384r1:secp521r1;
  ssl_session_cache shared:kx_tls:10m;
  ssl_session_timeout 1h;
  ssl_session_tickets off;
  # Plain HTTP sent to the HTTPS port (e.g. http://server:5000 typed by hand): send the browser to HTTPS instead of «400».
  error_page 497 =301 https://\$host$REDIRECT_PORT\$request_uri;
  include /etc/nginx/kx/locations.conf;
}
EOF
  else
    cat <<EOF
server {
  listen 80;
  server_name _;
  include /etc/nginx/kx/locations.conf;
}
EOF
  fi
} > "$OUT"

echo "kx-web: site written (TLS=$TLS, trusted proxies: ${PROXIES:-none}, CSP: $CSP_MODE)"
