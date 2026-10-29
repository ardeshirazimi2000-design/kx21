#!/usr/bin/env bash
# Builds the offline install bundle (بستهٔ نصب آفلاین) of the commissions system:
#   bash deploy/offline/build-bundle.sh [output-dir]
# Needs Docker and internet on the build machine only. The result, kx21-offline-<version>.tar, holds the
# images, Docker for servers without it, the installer, backup/restore scripts, the Persian guide and the APK
# (APK=path/to/app.apk, optional).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${1:-$REPO/dist-offline}"
DOCKER_STATIC="${DOCKER_STATIC:-docker-29.9.2.tgz}"
COMPOSE_VERSION="${COMPOSE_VERSION:-v2.40.3}"
VERSION="${VERSION:-$(date +%Y%m%d)-$(git -C "$REPO" rev-parse --short HEAD)}"
NAME="kx21-offline-$VERSION"
STAGE="$OUT_DIR/$NAME"

# SKIP_BUILD=1: kx21-api:$VERSION and kx21-web:$VERSION were already built (e.g. behind a proxy).
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> building images ($VERSION)"
  docker build -q -f "$REPO/apps/api/Dockerfile" -t "kx21-api:$VERSION" "$REPO" >/dev/null
  docker build -q -f "$REPO/apps/web/Dockerfile" -t "kx21-web:$VERSION" "$REPO" >/dev/null
fi
docker pull -q postgres:16-alpine >/dev/null

rm -rf "$STAGE"
mkdir -p "$STAGE/images" "$STAGE/docker" "$STAGE/deploy"
echo "==> saving images"
docker save postgres:16-alpine "kx21-api:$VERSION" "kx21-web:$VERSION" | gzip -1 > "$STAGE/images/kx21-images.tar.gz"

echo "==> Docker for servers without it"
curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/$DOCKER_STATIC" -o "$STAGE/docker/$DOCKER_STATIC"
curl -fsSL "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64" -o "$STAGE/docker/docker-compose"

cp "$REPO/deploy/offline/docker-compose.yml" "$REPO/deploy/offline/install.sh" "$STAGE/"
cp "$REPO/deploy/offline/راهنما.html" "$STAGE/"
cp "$REPO/deploy/backup.sh" "$REPO/deploy/restore.sh" "$STAGE/deploy/"
echo "$VERSION" > "$STAGE/VERSION"
[ -n "${APK:-}" ] && cp "$APK" "$STAGE/kx-commissions.apk"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

echo "==> packing"
tar -C "$OUT_DIR" -cf "$OUT_DIR/$NAME.tar" "$NAME"
rm -rf "$STAGE"
ls -lh "$OUT_DIR/$NAME.tar"
