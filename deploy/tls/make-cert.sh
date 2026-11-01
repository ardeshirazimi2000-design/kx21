#!/usr/bin/env bash
# Internal certificate for HTTPS until the chamber has one from a public authority (docs/11-https.md).
#
#   bash deploy/tls/make-cert.sh <folder> [name-or-address ...]
#
# Creates, once, a small certificate authority of this installation (kx21-ca.crt / kx21-ca.key, 10 years) and a server
# certificate signed by it for the given names and addresses (default: this server's addresses and host name), as
# fullchain.pem and privkey.pem, which the web container serves. Install kx21-ca.crt once on the chamber's computers
# and phones (or in the browser) and they trust the system without warnings. Run again to add names or renew: the
# authority stays, only the server certificate is replaced. Keys: elliptic curve P-256, SHA-256 signatures.
set -euo pipefail
DIR="${1:?usage: make-cert.sh <folder> [name-or-address ...]}"
shift || true
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
mkdir -p "$DIR"
chmod 700 "$DIR"
cd "$DIR"

NAMES=("$@")
if [ ${#NAMES[@]} -eq 0 ]; then
  read -r -a NAMES <<<"$(hostname -I 2>/dev/null || true)"
  NAMES+=("$(hostname)" localhost 127.0.0.1)
fi
SAN=""
for n in "${NAMES[@]}"; do
  [ -n "$n" ] || continue
  if [[ "$n" =~ ^[0-9.]+$ || "$n" == *:* ]]; then SAN+="IP:$n,"; else SAN+="DNS:$n,"; fi
done
SAN="${SAN%,}"

if [ ! -s kx21-ca.key ]; then
  (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out kx21-ca.key)
  openssl req -x509 -new -key kx21-ca.key -sha256 -days 3650 -out kx21-ca.crt \
    -subj "/O=Commissions System/CN=Commissions System Internal CA $(date +%Y%m%d)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign"
  cp kx21-ca.crt kx21-ca.cer   # the same certificate, with the extension Windows opens directly
  echo "Created the installation's certificate authority: $DIR/kx21-ca.crt"
fi

(umask 077; openssl ecparam -name prime256v1 -genkey -noout -out privkey.pem)
openssl req -new -key privkey.pem -out server.csr -subj "/O=Commissions System/CN=${NAMES[0]}"
cat > server.ext <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyAgreement
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EXT
# 825 days: the longest validity browsers accept for a server certificate.
openssl x509 -req -in server.csr -CA kx21-ca.crt -CAkey kx21-ca.key -CAcreateserial -days 825 -sha256 -extfile server.ext -out server.crt 2>/dev/null
cat server.crt kx21-ca.crt > fullchain.pem
rm -f server.csr server.ext
chmod 600 privkey.pem kx21-ca.key
chmod 644 fullchain.pem server.crt kx21-ca.crt kx21-ca.cer
echo "Server certificate for: $SAN (valid 825 days)"
echo "Give $DIR/kx21-ca.crt (or kx21-ca.cer) to users to install once."
