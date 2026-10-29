#!/usr/bin/env bash
# Restores a backup made by deploy/backup.sh and verifies it.
#
#   CONFIRM_RESTORE=yes sudo bash deploy/restore.sh /var/backups/kx21/kx21-<time>.tar.enc
#
# Safe by default: it restores only into EMPTY databases and EMPTY file folders, and never overwrites the live
# configuration (/etc/kx21*.env or .env). Rehearse on a separate test server or test databases first.
#
# Options (environment variables):
#   BACKUP_PASSPHRASE_FILE=/root/kx21-backup.pass  the passphrase the backup was made with
#   RESTORE_CONFIG_OUT=./restored-config-<time>    where the backed-up configuration files (with the keys) are written
#   RESTORE_REPLACE=1      allow restoring over NON-empty targets. A safety backup of the current state is taken first
#                          (deploy/backup.sh); then the targets are emptied. Stop the application services before.
#   RESTORE_VERIFY=0       skip the verification (default: verify files, hashes, keys, signatures and the audit chain)
#   OFFICE=0               the backup has no office automation
#   MODE=docker|systemd    default: the mode of the backup
# systemd mode:
#   RESTORE_MEETINGS_DB / RESTORE_OFFICE_DB        target databases (default: the names in the backup's config)
#   RESTORE_UPLOAD_DIR / RESTORE_STORAGE_DIR       target folders (default: the folders in the backup's config)
#   ENV_FILE / OFFICE_ENV_FILE                     the target server's config (to check its keys match the backup)
#   PG_RUN="sudo -u postgres"                      how to run psql/pg_restore (empty: PGHOST/PGUSER/PGPASSWORD)
#   APP_DIR=/opt/kx21  RESTORE_FILE_OWNER=kx       where the built app is (verification) and who owns the files
# docker mode: run from the repository of the target stack, with its .env in place (the keys must be the backup's:
#   copy RESTORE_CONFIG_OUT/docker.env to .env on a new server) and `docker compose up -d db office-db` running.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

log() { echo "[restore] $*" >&2; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

BACKUP="${1:-}"
[ -n "$BACKUP" ] && [ -f "$BACKUP" ] || die "usage: CONFIRM_RESTORE=yes bash deploy/restore.sh <kx21-…tar.enc>"
[ "${CONFIRM_RESTORE:-}" = "yes" ] || die "set CONFIRM_RESTORE=yes to restore"
BACKUP="$(cd "$(dirname "$BACKUP")" && pwd)/$(basename "$BACKUP")"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/root/kx21-backup.pass}"
[ -s "$BACKUP_PASSPHRASE_FILE" ] || die "passphrase file $BACKUP_PASSPHRASE_FILE not found"
TS="$(date +%Y%m%d-%H%M%S)"
RESTORE_CONFIG_OUT="${RESTORE_CONFIG_OUT:-$REPO/restored-config-$TS}"
RESTORE_REPLACE="${RESTORE_REPLACE:-0}"
RESTORE_VERIFY="${RESTORE_VERIFY:-1}"

env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
db_name() { local u="${1%%\?*}"; echo "${u##*/}"; }

# 1. Decrypt, unpack and check every file against the manifest.
if [ -f "$BACKUP.sha256" ]; then
  (cd "$(dirname "$BACKUP")" && sha256sum -c --quiet "$(basename "$BACKUP").sha256") || die "the backup file is damaged (checksum mismatch)"
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$BACKUP" | tar -C "$WORK" -xf - \
  || die "cannot decrypt the backup (wrong passphrase or damaged file)"
SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'kx21-*' | head -n 1)"
[ -n "$SRC" ] || die "not a kx21 backup"
(cd "$SRC" && sha256sum -c --quiet SHA256SUMS) || die "backup contents do not match their manifest"
BACKUP_MODE="$(env_value "$SRC/info.txt" mode)"
MODE="${MODE:-$BACKUP_MODE}"
OFFICE="${OFFICE:-$(env_value "$SRC/info.txt" office)}"
log "backup $(env_value "$SRC/info.txt" created) ($BACKUP_MODE install) verified; restoring in $MODE mode"

# 2. The configuration (keys) goes to a separate folder; the live configuration is never overwritten.
mkdir -p "$RESTORE_CONFIG_OUT"
chmod 700 "$RESTORE_CONFIG_OUT"
cp -p "$SRC"/config/* "$RESTORE_CONFIG_OUT"/
chmod 600 "$RESTORE_CONFIG_OUT"/*
log "configuration files (with keys) written to $RESTORE_CONFIG_OUT"

# Office key of the backup: files and signing keys were encrypted with it.
if [ "$BACKUP_MODE" = "docker" ]; then
  BACKUP_OFFICE_KEY="$(env_value "$SRC/config/docker.env" OFFICE_DATA_ENCRYPTION_KEY)"
  BACKUP_MEETINGS_JWT="$(env_value "$SRC/config/docker.env" JWT_SECRET)"
else
  BACKUP_OFFICE_KEY="$( [ "$OFFICE" = "1" ] && env_value "$SRC/config/kx21-office.env" DATA_ENCRYPTION_KEY || true)"
  BACKUP_MEETINGS_JWT="$(env_value "$SRC/config/kx21.env" JWT_SECRET)"
fi
# Compares without printing either value.
same_key() { [ "$(printf %s "$1" | sha256sum)" = "$(printf %s "$2" | sha256sum)" ]; }

safety_backup() { # of the targets about to be replaced
  log "taking a safety backup of the current state first"
  if [ "$MODE" = "systemd" ]; then
    BACKUP_DIR="${SAFETY_BACKUP_DIR:-/var/backups/kx21}" MODE=systemd ENV_FILE="$ENV_FILE" OFFICE_ENV_FILE="$OFFICE_ENV_FILE" OFFICE="$OFFICE" PG_RUN="$PG_RUN" \
      BACKUP_MEETINGS_DB="$RESTORE_MEETINGS_DB" BACKUP_UPLOAD_DIR="$RESTORE_UPLOAD_DIR" BACKUP_OFFICE_DB="${RESTORE_OFFICE_DB:-}" BACKUP_STORAGE_DIR="${RESTORE_STORAGE_DIR:-}" \
      bash "$REPO/deploy/backup.sh" >/dev/null || die "safety backup failed: nothing was changed"
  else
    BACKUP_DIR="${SAFETY_BACKUP_DIR:-/var/backups/kx21}" MODE=docker OFFICE="$OFFICE" bash "$REPO/deploy/backup.sh" >/dev/null || die "safety backup failed: nothing was changed"
  fi
}

if [ "$MODE" = "systemd" ]; then
  ENV_FILE="${ENV_FILE:-/etc/kx21.env}"
  OFFICE_ENV_FILE="${OFFICE_ENV_FILE:-/etc/kx21-office.env}"
  if [ -z "${PG_RUN+x}" ]; then
    if [ "$(id -u)" -eq 0 ] && id postgres >/dev/null 2>&1; then PG_RUN="sudo -u postgres"; else PG_RUN=""; fi
  fi
  [ "$BACKUP_MODE" = "systemd" ] || die "a docker backup restores in docker mode (or set the RESTORE_* targets and copy the keys yourself)"
  MEETINGS_URL="$(env_value "$SRC/config/kx21.env" DATABASE_URL)"
  RESTORE_MEETINGS_DB="${RESTORE_MEETINGS_DB:-$(db_name "$MEETINGS_URL")}"
  RESTORE_UPLOAD_DIR="${RESTORE_UPLOAD_DIR:-$(env_value "$SRC/config/kx21.env" UPLOAD_DIR)}"
  if [ "$OFFICE" = "1" ]; then
    OFFICE_URL="$(env_value "$SRC/config/kx21-office.env" DATABASE_URL)"
    RESTORE_OFFICE_DB="${RESTORE_OFFICE_DB:-$(db_name "$OFFICE_URL")}"
    RESTORE_STORAGE_DIR="${RESTORE_STORAGE_DIR:-$(env_value "$SRC/config/kx21-office.env" STORAGE_DIR)}"
  fi

  # The target server's keys must be the backup's, or the restored files cannot be read.
  if [ -f "$ENV_FILE" ] && ! same_key "$(env_value "$ENV_FILE" JWT_SECRET)" "$BACKUP_MEETINGS_JWT"; then
    die "JWT_SECRET in $ENV_FILE differs from the backup's: install $RESTORE_CONFIG_OUT/kx21.env as $ENV_FILE first"
  fi
  if [ "$OFFICE" = "1" ] && [ -f "$OFFICE_ENV_FILE" ] && ! same_key "$(env_value "$OFFICE_ENV_FILE" DATA_ENCRYPTION_KEY)" "$BACKUP_OFFICE_KEY"; then
    die "DATA_ENCRYPTION_KEY in $OFFICE_ENV_FILE differs from the backup's: install $RESTORE_CONFIG_OUT/kx21-office.env as $OFFICE_ENV_FILE first"
  fi

  psql_q() { $PG_RUN psql -X -v ON_ERROR_STOP=1 -tA -d "$1" -c "$2"; }
  # A dump from a newer pg_dump carries settings an older server rejects: client and server must be the same major.
  CLIENT_MAJOR="$($PG_RUN pg_restore --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  SERVER_MAJOR="$(psql_q postgres "SHOW server_version_num" | cut -c1-2)"
  [ "$CLIENT_MAJOR" = "$SERVER_MAJOR" ] || die "pg_restore is version $CLIENT_MAJOR but the server is $SERVER_MAJOR: use the PostgreSQL $SERVER_MAJOR client tools"
  db_tables() { psql_q postgres "SELECT 1 FROM pg_database WHERE datname = '$1'" | grep -q 1 || { echo 0; return; }; psql_q "$1" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"; }
  dir_used() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

  TARGETS_USED=0
  [ "$(db_tables "$RESTORE_MEETINGS_DB")" != "0" ] && TARGETS_USED=1
  dir_used "$RESTORE_UPLOAD_DIR" && TARGETS_USED=1
  if [ "$OFFICE" = "1" ]; then
    [ "$(db_tables "$RESTORE_OFFICE_DB")" != "0" ] && TARGETS_USED=1
    dir_used "$RESTORE_STORAGE_DIR" && TARGETS_USED=1
  fi
  if [ "$TARGETS_USED" = "1" ]; then
    [ "$RESTORE_REPLACE" = "1" ] || die "the target databases or folders are not empty. Restore onto a test target, or stop the services and set RESTORE_REPLACE=1"
    for svc in kx21 kx21-office; do
      systemctl is-active --quiet "$svc" 2>/dev/null && die "stop $svc first (systemctl stop kx21 kx21-office)"
    done
    safety_backup
  fi

  restore_db() { # name dump
    local owner
    owner="$(echo "$3" | sed -E 's|^[a-z]+://([^:@/]+).*|\1|')"
    psql_q postgres "SELECT 1 FROM pg_roles WHERE rolname = '$owner'" | grep -q 1 || die "database role $owner does not exist: create it first"
    if [ "$(db_tables "$1")" != "0" ]; then psql_q postgres "DROP DATABASE \"$1\" WITH (FORCE)"; fi
    psql_q postgres "SELECT 1 FROM pg_database WHERE datname = '$1'" | grep -q 1 || psql_q postgres "CREATE DATABASE \"$1\" OWNER \"$owner\""
    log "database $1"
    $PG_RUN pg_restore --exit-on-error -d "$1" < "$2"
  }
  restore_dir() { # dir archive
    mkdir -p "$1"
    find "$1" -mindepth 1 -delete
    tar -C "$1" -xzf "$2"
    if [ "$(id -u)" -eq 0 ] && id "${RESTORE_FILE_OWNER:-kx}" >/dev/null 2>&1; then chown -R "${RESTORE_FILE_OWNER:-kx}:${RESTORE_FILE_OWNER:-kx}" "$1"; fi
    log "files in $1"
  }
  restore_db "$RESTORE_MEETINGS_DB" "$SRC/meetings.dump" "$MEETINGS_URL"
  restore_dir "$RESTORE_UPLOAD_DIR" "$SRC/meetings-files.tar.gz"
  if [ "$OFFICE" = "1" ]; then
    restore_db "$RESTORE_OFFICE_DB" "$SRC/office.dump" "$OFFICE_URL"
    restore_dir "$RESTORE_STORAGE_DIR" "$SRC/office-files.tar.gz"
  fi

  if [ "$RESTORE_VERIFY" = "1" ]; then
    log "verifying meeting documents"
    psql_q "$RESTORE_MEETINGS_DB" "SELECT sha256 || '  ' || storage_key FROM documents" > "$WORK/meetings.sha256"
    if [ -s "$WORK/meetings.sha256" ]; then
      (cd "$RESTORE_UPLOAD_DIR" && sha256sum -c --quiet "$WORK/meetings.sha256") || die "meeting documents do not match their recorded hashes"
    fi
    log "meeting documents: $(wc -l < "$WORK/meetings.sha256") verified"
    if [ "$OFFICE" = "1" ]; then
      log "verifying office automation"
      APP_DIR="${APP_DIR:-/opt/kx21}"
      VERIFY="$APP_DIR/apps/office-api/dist/db/verify-backup.js"
      [ -f "$VERIFY" ] || VERIFY="$REPO/apps/office-api/dist/db/verify-backup.js"
      VERIFY_RUN="node $VERIFY"
      if [ ! -f "$VERIFY" ]; then
        [ -x "$REPO/node_modules/.bin/tsx" ] || die "build the office API first (npm run build -w @kx/office-api) to verify"
        VERIFY_RUN="$REPO/node_modules/.bin/tsx $REPO/apps/office-api/src/db/verify-backup.ts"
      fi
      TARGET_URL="$(echo "$OFFICE_URL" | sed -E "s|/[^/?]+(\\?.*)?$|/$RESTORE_OFFICE_DB\\1|")"
      (
        set -a
        # shellcheck disable=SC1091
        . "$RESTORE_CONFIG_OUT/kx21-office.env"
        set +a
        DATABASE_URL="${RESTORE_OFFICE_DATABASE_URL:-$TARGET_URL}" STORAGE_DIR="$RESTORE_STORAGE_DIR" $VERIFY_RUN
      ) || die "office automation verification failed"
    fi
  fi
else
  [ -f .env ] || die "no .env here: copy $RESTORE_CONFIG_OUT/docker.env to .env (the backup's keys) and start db and office-db first"
  if [ "$BACKUP_MODE" = "docker" ]; then
    same_key "$(env_value .env OFFICE_DATA_ENCRYPTION_KEY)" "$BACKUP_OFFICE_KEY" \
      || die "OFFICE_DATA_ENCRYPTION_KEY in .env differs from the backup's: use $RESTORE_CONFIG_OUT/docker.env as .env"
    same_key "$(env_value .env JWT_SECRET)" "$BACKUP_MEETINGS_JWT" || die "JWT_SECRET in .env differs from the backup's: use $RESTORE_CONFIG_OUT/docker.env as .env"
  else
    die "a systemd backup restores in systemd mode"
  fi
  dc() { docker compose "$@"; }
  [ -n "$(dc ps -q db)" ] || die "start the databases first: docker compose up -d db office-db"
  db_tables() { dc exec -T "$1" psql -X -U kx -d "$2" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"; }
  vol_used() { [ -n "$(dc run --rm --no-deps -T --entrypoint sh "$1" -c "ls -A $2")" ]; }
  TARGETS_USED=0
  [ "$(db_tables db kx)" != "0" ] && TARGETS_USED=1
  vol_used api /data/uploads && TARGETS_USED=1
  if [ "$OFFICE" = "1" ]; then
    [ "$(db_tables office-db kx_office)" != "0" ] && TARGETS_USED=1
    vol_used office-api /data/storage && TARGETS_USED=1
  fi
  if [ "$TARGETS_USED" = "1" ]; then
    [ "$RESTORE_REPLACE" = "1" ] || die "the target databases or volumes are not empty. Restore onto a test stack (COMPOSE_PROJECT_NAME), or set RESTORE_REPLACE=1"
    safety_backup
    dc stop api office-api web office-web >/dev/null 2>&1 || true
  fi
  restore_db() { # service db dump
    dc exec -T "$1" psql -X -v ON_ERROR_STOP=1 -U kx -d postgres -c "DROP DATABASE IF EXISTS \"$2\" WITH (FORCE)" -c "CREATE DATABASE \"$2\" OWNER kx" >/dev/null
    log "database $2"
    dc exec -T "$1" pg_restore --exit-on-error -U kx -d "$2" < "$3"
  }
  restore_vol() { # service dir archive
    dc run --rm --no-deps -T --entrypoint sh "$1" -c "find $2 -mindepth 1 -delete && tar -xzf - -C $2" < "$3"
    log "files in $1:$2"
  }
  restore_db db kx "$SRC/meetings.dump"
  restore_vol api /data/uploads "$SRC/meetings-files.tar.gz"
  if [ "$OFFICE" = "1" ]; then
    restore_db office-db kx_office "$SRC/office.dump"
    restore_vol office-api /data/storage "$SRC/office-files.tar.gz"
  fi
  if [ "$RESTORE_VERIFY" = "1" ]; then
    log "verifying meeting documents"
    dc exec -T db psql -X -U kx -d kx -tAc "SELECT sha256 || '  ' || storage_key FROM documents" > "$WORK/meetings.sha256"
    if [ -s "$WORK/meetings.sha256" ]; then
      dc run --rm --no-deps -T --entrypoint sh api -c 'cd /data/uploads && sha256sum -c - >/dev/null' < "$WORK/meetings.sha256" \
        || die "meeting documents do not match their recorded hashes"
    fi
    log "meeting documents: $(grep -c . "$WORK/meetings.sha256" || true) verified"
    if [ "$OFFICE" = "1" ]; then
      log "verifying office automation"
      dc run --rm --no-deps -T office-api node dist/db/verify-backup.js || die "office automation verification failed"
    fi
  fi
fi
log "restore complete"
