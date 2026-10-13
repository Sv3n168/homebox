#!/bin/bash
# hb-backup — encrypted backups of the Homebox data volume via rclone crypt.
#
#   hb-backup backup                 back up now
#   hb-backup list                   list backups on the remote
#   hb-backup verify [NAME|latest]   download, decrypt and check a backup (changes nothing)
#   hb-backup restore [NAME|latest] --yes
#                                    replace /data with a backup (Homebox must be stopped)
#   hb-backup check                  verify configuration and remote access
#
# Everything is encrypted client-side by rclone's crypt backend (XSalsa20-
# Poly1305, file names encrypted too) before it leaves the machine. Without
# BACKUP_PASSWORD and BACKUP_SALT the backups cannot be read — by anyone,
# including you. Keep both in a password manager.
set -euo pipefail

[ -f /etc/hb-backup.env ] && source /etc/hb-backup.env

DATA="${HB_DATA_DIR:-/data}"
LOCAL="${HB_LOCAL_DIR:-/backups}"
DB_NAME="${HB_DB_NAME:-homebox.db}"
PREFIX="homebox"
CRYPT="hbcrypt:"

log() { echo "[hb-backup $(date '+%F %T')] $*" >&2; }
die() { log "ERROR: $*"; ping_health fail; exit 1; }

ping_health() {
  [ -n "${HEALTHCHECK_URL:-}" ] || return 0
  local suffix=""
  [ "${1:-}" = "fail" ] && suffix="/fail"
  curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}${suffix}" >/dev/null 2>&1 || true
}

# The crypt remote is defined from the environment so the passwords live in
# the stack config (and your password manager), not in a file in a volume.
setup_crypt() {
  [ -n "${BACKUP_PASSWORD:-}" ] || die "BACKUP_PASSWORD is not set"
  [ -n "${BACKUP_SALT:-}" ] || die "BACKUP_SALT is not set"
  export RCLONE_CONFIG_HBCRYPT_TYPE=crypt
  export RCLONE_CONFIG_HBCRYPT_REMOTE="${BACKUP_REMOTE}"
  export RCLONE_CONFIG_HBCRYPT_FILENAME_ENCRYPTION=standard
  export RCLONE_CONFIG_HBCRYPT_DIRECTORY_NAME_ENCRYPTION=true
  RCLONE_CONFIG_HBCRYPT_PASSWORD="$(rclone obscure "${BACKUP_PASSWORD}")"
  RCLONE_CONFIG_HBCRYPT_PASSWORD2="$(rclone obscure "${BACKUP_SALT}")"
  export RCLONE_CONFIG_HBCRYPT_PASSWORD RCLONE_CONFIG_HBCRYPT_PASSWORD2
}

remote_list() {
  rclone lsf "${CRYPT}" --files-only 2>/dev/null | grep -E "^${PREFIX}-[0-9]{8}-[0-9]{6}\.tar\.gz$" | sort || true
}

resolve_name() {
  local want="${1:-latest}"
  if [ "$want" = "latest" ]; then
    want="$(remote_list | tail -n1)"
    if [ -z "$want" ]; then
      local raw
      raw="$(rclone lsf "${BACKUP_REMOTE}" --files-only 2>/dev/null | grep -c . || true)"
      [ "$raw" -gt 0 ] && die "${raw} encrypted file(s) on ${BACKUP_REMOTE}, but none can be decrypted – are BACKUP_PASSWORD and BACKUP_SALT the ones used for the backup?"
      die "no backups found on ${BACKUP_REMOTE}"
    fi
  fi
  echo "$want"
}

check_db() {
  local result
  result="$(sqlite3 "$1" "PRAGMA integrity_check;" 2>&1 | head -n1)"
  [ "$result" = "ok" ] || die "database integrity check failed for $1: $result"
}

cmd_check() {
  setup_crypt
  [ -f "${DATA}/${DB_NAME}" ] || die "no database at ${DATA}/${DB_NAME} – is the Homebox volume mounted at ${DATA}?"
  if [[ "${BACKUP_REMOTE}" == *:* ]] && [ ! -f "${RCLONE_CONFIG}" ]; then
    die "no rclone config at ${RCLONE_CONFIG} – run 'rclone config' once to connect OneDrive (see README)"
  fi
  rclone mkdir "${CRYPT}" || die "cannot reach ${BACKUP_REMOTE} – check the OneDrive connection ('rclone config reconnect onedrive:')"
  log "configuration OK – ${BACKUP_REMOTE} reachable, $(remote_list | wc -l) backup(s) there"
}

cmd_backup() {
  setup_crypt
  [ -f "${DATA}/${DB_NAME}" ] || die "no database at ${DATA}/${DB_NAME}"

  local stamp name work
  # UTC, so names sort by age whatever TZ the container runs in.
  stamp="$(date -u '+%Y%m%d-%H%M%S')"
  name="${PREFIX}-${stamp}.tar.gz"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  log "creating ${name}"
  # Consistent copy of the live database (WAL mode, Homebox keeps running).
  sqlite3 "${DATA}/${DB_NAME}" ".timeout 30000" ".backup '${work}/${DB_NAME}'" || die "sqlite backup failed"
  check_db "${work}/${DB_NAME}"

  {
    echo "created=${stamp}"
    echo "host=$(hostname)"
    echo "db_sha256=$(sha256sum "${work}/${DB_NAME}" | cut -d' ' -f1)"
    echo "files=$(find "${DATA}" -type f ! -name "${DB_NAME}*" ! -path '*/.pre-restore-*' | wc -l)"
  } > "${work}/BACKUP-INFO"

  tar -czf "${work}/${name}" \
    -C "${DATA}" \
    --exclude="./${DB_NAME}" --exclude="./${DB_NAME}-wal" --exclude="./${DB_NAME}-shm" \
    --exclude='./.pre-restore-*' \
    . \
    -C "${work}" "${DB_NAME}" BACKUP-INFO || die "tar failed"
  tar -tzf "${work}/${name}" >/dev/null || die "archive is unreadable"
  log "archive $(du -h "${work}/${name}" | cut -f1)"

  rclone copyto "${work}/${name}" "${CRYPT}${name}" --retries 5 || die "upload to ${BACKUP_REMOTE} failed"
  rclone check "${work}" "${CRYPT}" --one-way --include "${name}" --download >/dev/null 2>&1 \
    || die "uploaded backup does not match the local archive"
  log "uploaded and verified ${name} -> ${BACKUP_REMOTE} (encrypted)"

  # Local copies for quick restores.
  if [ "${BACKUP_LOCAL_KEEP:-0}" -gt 0 ] && [ -d "${LOCAL}" ]; then
    cp "${work}/${name}" "${LOCAL}/${name}"
    ls -1 "${LOCAL}"/${PREFIX}-*.tar.gz 2>/dev/null | sort | head -n "-${BACKUP_LOCAL_KEEP}" | xargs -r rm -f
  fi

  rotate
  ping_health
}

# Delete remote backups older than BACKUP_KEEP_DAYS, but always keep the newest
# BACKUP_KEEP_MIN — if backups silently stopped, old ones must not run out.
rotate() {
  local keep_min="${BACKUP_KEEP_MIN:-10}" keep_days="${BACKUP_KEEP_DAYS:-60}"
  local cutoff all count
  cutoff="$(date -u -d "-${keep_days} days" '+%Y%m%d-%H%M%S')"
  all="$(remote_list)"
  count="$(echo "$all" | grep -c . || true)"
  echo "$all" | head -n "-${keep_min}" | while read -r f; do
    [ -n "$f" ] || continue
    local ts="${f#${PREFIX}-}"; ts="${ts%.tar.gz}"
    if [[ "$ts" < "$cutoff" ]]; then
      rclone deletefile "${CRYPT}${f}" && log "rotated out ${f}"
    fi
  done
  log "${count} backup(s) on remote before rotation (keep >= ${keep_min}, max age ${keep_days} days)"
}

cmd_list() {
  setup_crypt
  rclone lsl "${CRYPT}" 2>/dev/null | sort -k4 || die "cannot list ${BACKUP_REMOTE}"
}

# Download + decrypt + unpack + integrity-check into $1. Prints the backup name.
fetch_backup() {
  local name="$1" dest="$2"
  if [ -f "${LOCAL}/${name}" ] && [ "${HB_PREFER_REMOTE:-false}" != "true" ]; then
    log "using local copy ${LOCAL}/${name}"
    cp "${LOCAL}/${name}" "${dest}/${name}"
  else
    log "downloading and decrypting ${name}"
    rclone copyto "${CRYPT}${name}" "${dest}/${name}" --retries 5 || die "download of ${name} failed"
  fi
  mkdir -p "${dest}/x"
  tar -xzf "${dest}/${name}" -C "${dest}/x" || die "archive ${name} is damaged"
  [ -f "${dest}/x/${DB_NAME}" ] || die "archive ${name} contains no ${DB_NAME}"
  check_db "${dest}/x/${DB_NAME}"
  if [ -f "${dest}/x/BACKUP-INFO" ]; then
    local want got
    want="$(grep '^db_sha256=' "${dest}/x/BACKUP-INFO" | cut -d= -f2)"
    got="$(sha256sum "${dest}/x/${DB_NAME}" | cut -d' ' -f1)"
    [ -z "$want" ] || [ "$want" = "$got" ] || die "database checksum mismatch in ${name}"
  fi
}

cmd_verify() {
  setup_crypt
  local name work
  name="$(resolve_name "${1:-latest}")"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  fetch_backup "$name" "$work"
  local entities
  entities="$(sqlite3 "${work}/x/${DB_NAME}" "SELECT count(*) FROM entities;" 2>/dev/null || echo "?")"
  log "backup ${name} is readable: database OK, ${entities} entities, $(find "${work}/x" -type f | wc -l) files"
  cat "${work}/x/BACKUP-INFO" 2>/dev/null || true
}

homebox_running() {
  [ -n "${HOMEBOX_URL:-}" ] && curl -fsS -m 5 "${HOMEBOX_URL%/}/api/v1/status" >/dev/null 2>&1
}

cmd_restore() {
  local target="latest" yes=false
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) yes=true ;;
      *) target="$arg" ;;
    esac
  done
  setup_crypt
  local name
  name="$(resolve_name "$target")"

  if [ "$yes" != true ]; then
    echo "This replaces ALL Homebox data in ${DATA} with backup ${name}."
    echo "The current data is moved aside to ${DATA}/.pre-restore-<timestamp> (not deleted)."
    echo "Stop the Homebox container first, then run:  hb-backup restore ${name} --yes"
    exit 2
  fi
  if homebox_running; then
    die "Homebox is still running at ${HOMEBOX_URL} – stop the homebox container first"
  fi

  local work stamp aside
  work="$(mktemp -d "${DATA}/.restore-work-XXXXXX")"
  trap 'rm -rf "$work"' RETURN
  fetch_backup "$name" "$work"

  stamp="$(date '+%Y%m%d-%H%M%S')"
  aside="${DATA}/.pre-restore-${stamp}"
  mkdir -p "$aside"
  find "${DATA}" -mindepth 1 -maxdepth 1 \
    ! -name '.pre-restore-*' ! -name "$(basename "$work")" \
    -exec mv {} "$aside/" \;
  log "current data moved to ${aside}"

  rm -f "${work}/x/BACKUP-INFO"
  (cd "${work}/x" && tar -cf - .) | (cd "${DATA}" && tar -xpf -)
  check_db "${DATA}/${DB_NAME}"
  log "restored ${name}. Start the homebox container again."
  log "When everything looks right you can delete ${aside}."
}

cmd_help() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-help}" in
  backup) cmd_backup ;;
  list) cmd_list ;;
  verify) shift; cmd_verify "${1:-latest}" ;;
  restore) shift; cmd_restore "$@" ;;
  check) cmd_check ;;
  help|-h|--help) cmd_help ;;
  *) echo "unknown command: $1"; cmd_help; exit 1 ;;
esac
