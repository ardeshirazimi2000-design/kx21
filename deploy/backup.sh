#!/usr/bin/env bash
# Backup of the whole platform: both databases (meetings and office automation), both file stores (meeting uploads,
# office attachments) and the configuration files that hold the keys (without DATA_ENCRYPTION_KEY / JWT_SECRET the
# encrypted attachments, signing keys and integration secrets cannot be read back). Everything goes into one
# encrypted file: letter text is plain in the database, so a backup is as sensitive as the server itself.
#
#   sudo bash deploy/backup.sh
#
# Options (environment variables):
#   BACKUP_DIR=/var/backups/kx21                  where kx21-<time>.tar.enc files are written
#   BACKUP_KEEP=14                                how many backups to keep (older ones are deleted)
#   BACKUP_PASSPHRASE_FILE=/root/kx21-backup.pass encryption passphrase (create once, keep a copy OFF this server:
#                                                 without it no backup can be restored)
#   MODE=docker|systemd                           detected: systemd when /etc/kx21.env exists, else docker
#   OFFICE=0                                      the install has no office automation
# systemd mode only:
#   ENV_FILE=/etc/kx21.env  OFFICE_ENV_FILE=/etc/kx21-office.env
#   PG_RUN="sudo -u postgres"                     how to run pg_dump (default: as the postgres user when root;
#                                                 empty = use PGHOST/PGUSER/PGPASSWORD from the environment)
#   BACKUP_MEETINGS_DB / BACKUP_OFFICE_DB / BACKUP_UPLOAD_DIR / BACKUP_STORAGE_DIR
#                                                 other databases/folders than those in the config files
# docker mode only: COMPOSE_PROJECT_NAME / COMPOSE_FILE as for docker compose.
#
# Restore: deploy/restore.sh (see docs/office/04-operations.md).
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-/var/backups/kx21}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/root/kx21-backup.pass}"
OFFICE="${OFFICE:-1}"
ENV_FILE="${ENV_FILE:-/etc/kx21.env}"
OFFICE_ENV_FILE="${OFFICE_ENV_FILE:-/etc/kx21-office.env}"
if [ -z "${MODE:-}" ]; then
  if [ -f "$ENV_FILE" ]; then MODE=systemd; else MODE=docker; fi
fi

log() { echo "[backup] $*" >&2; }
die() { echo "[backup] ERROR: $*" >&2; exit 1; }

[ -s "$BACKUP_PASSPHRASE_FILE" ] || die "no passphrase at $BACKUP_PASSPHRASE_FILE. Create it once with:
  (umask 077; openssl rand -base64 32 > $BACKUP_PASSPHRASE_FILE)
and keep a copy somewhere other than this server."

# Value of KEY in an env file, without sourcing it.
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
db_name() { local u="${1%%\?*}"; echo "${u##*/}"; }

TS="$(date +%Y%m%d-%H%M%S)"
NAME="kx21-$TS"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
OUT="$WORK/$NAME"
mkdir -p "$OUT/config"

if [ "$MODE" = "systemd" ]; then
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
  if [ -z "${PG_RUN+x}" ]; then
    if [ "$(id -u)" -eq 0 ] && id postgres >/dev/null 2>&1; then PG_RUN="sudo -u postgres"; else PG_RUN=""; fi
  fi
  MEETINGS_DB="${BACKUP_MEETINGS_DB:-$(db_name "$(env_value "$ENV_FILE" DATABASE_URL)")}"
  UPLOAD_DIR="${BACKUP_UPLOAD_DIR:-$(env_value "$ENV_FILE" UPLOAD_DIR)}"
  # Databases first, then files: every file a database row points to is already on disk when it is copied.
  log "meetings database ($MEETINGS_DB)"
  $PG_RUN pg_dump -Fc "$MEETINGS_DB" > "$OUT/meetings.dump"
  if [ "$OFFICE" = "1" ]; then
    [ -f "$OFFICE_ENV_FILE" ] || die "$OFFICE_ENV_FILE not found (OFFICE=0 if office automation is not installed)"
    OFFICE_DB="${BACKUP_OFFICE_DB:-$(db_name "$(env_value "$OFFICE_ENV_FILE" DATABASE_URL)")}"
    STORAGE_DIR="${BACKUP_STORAGE_DIR:-$(env_value "$OFFICE_ENV_FILE" STORAGE_DIR)}"
    log "office database ($OFFICE_DB)"
    $PG_RUN pg_dump -Fc "$OFFICE_DB" > "$OUT/office.dump"
  fi
  log "meeting uploads"
  tar -C "${UPLOAD_DIR:?UPLOAD_DIR missing in $ENV_FILE}" -czf "$OUT/meetings-files.tar.gz" .
  if [ "$OFFICE" = "1" ]; then
    log "office attachments"
    tar -C "${STORAGE_DIR:?STORAGE_DIR missing in $OFFICE_ENV_FILE}" -czf "$OUT/office-files.tar.gz" .
  fi
  cp "$ENV_FILE" "$OUT/config/kx21.env"
  [ "$OFFICE" = "1" ] && cp "$OFFICE_ENV_FILE" "$OUT/config/kx21-office.env"
else
  [ -f .env ] || die "no .env in $(pwd) (docker mode): run from the repository the stack was installed from"
  dc() { docker compose "$@"; }
  [ -n "$(dc ps -q db)" ] || die "the db service is not running"
  log "meetings database"
  dc exec -T db pg_dump -U kx -Fc kx > "$OUT/meetings.dump"
  if [ "$OFFICE" = "1" ]; then
    log "office database"
    dc exec -T office-db pg_dump -U kx -Fc kx_office > "$OUT/office.dump"
  fi
  # Files are read through a throw-away container on the same volume (the services may keep running).
  log "meeting uploads"
  dc run --rm --no-deps -T --entrypoint sh api -c 'tar -C /data/uploads -czf - .' > "$OUT/meetings-files.tar.gz"
  if [ "$OFFICE" = "1" ]; then
    log "office attachments"
    dc run --rm --no-deps -T --entrypoint sh office-api -c 'tar -C /data/storage -czf - .' > "$OUT/office-files.tar.gz"
  fi
  cp .env "$OUT/config/docker.env"
fi

for f in "$OUT"/*.dump; do [ -s "$f" ] || die "empty database dump: $(basename "$f")"; done
{
  echo "created=$TS"
  echo "mode=$MODE"
  echo "office=$OFFICE"
  echo "revision=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "$OUT/info.txt"
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TARGET="$BACKUP_DIR/$NAME.tar.enc"
(umask 077; tar -C "$WORK" -cf - "$NAME" | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$TARGET.part")
mv "$TARGET.part" "$TARGET"
(cd "$BACKUP_DIR" && sha256sum "$NAME.tar.enc" > "$NAME.tar.enc.sha256")

# Retention: keep the newest $BACKUP_KEEP backups.
ls -1t "$BACKUP_DIR"/kx21-*.tar.enc 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done

log "done: $TARGET ($(du -h "$TARGET" | cut -f1))"
echo "$TARGET"
