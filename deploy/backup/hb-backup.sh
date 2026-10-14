#!/bin/bash
# hb-backup — encrypted backups of the Homebox data volume via rclone crypt.
#
#   hb-backup backup                 back up now
#   hb-backup list                   list backups on the remote
#   hb-backup verify [NAME|latest] [--remote]
#                                    download, decrypt and check a backup (changes nothing);
#                                    --remote ignores local copies and tests the OneDrive copy
#   hb-backup restore [NAME|latest] --yes
#                                    replace /data with a backup (Homebox must be stopped)
#   hb-backup check                  verify configuration and remote access
#   hb-backup status                 last backup and last restore test
#   hb-backup health                 exit 1 if backups stopped or a check failed
#                                    (used by the container health check)
#   hb-backup snapshot               local copy of the database, taken before every
#                                    (re)start of Homebox, i.e. before an update
#                                    migrates the database; never fails
#   hb-backup snapshots              list those copies
#   hb-backup restore-snapshot [NAME|latest] --yes
#                                    put a pre-update copy of the database back
#                                    (Homebox must be stopped; photos stay as they are)
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
die() { log "ERROR: $*"; write_status fail "$*"; ping_health fail; exit 1; }

# Results of the last backup and the last restore test, for "status" and the
# container health check. Kept in the /backups volume so they survive restarts.
STATUS_DIR="${HB_STATUS_DIR:-${LOCAL}/.status}"
STATUS_FOR=""
# Homebox reads this copy (same volume) and shows it under Collection → Tools.
STATUS_JSON="${DATA}/.hb-backup-status.json"

write_status() {
  [ -n "${STATUS_FOR}" ] || return 0
  mkdir -p "${STATUS_DIR}" 2>/dev/null || return 0
  printf '%s %s %s\n' "$1" "$(date +%s)" "${2:-}" > "${STATUS_DIR}/${STATUS_FOR}" 2>/dev/null || true
  write_status_json
}

status_entry() {
  local state when detail
  [ -f "${STATUS_DIR}/$1" ] || { echo null; return; }
  read -r state when detail < "${STATUS_DIR}/$1"
  detail="$(printf '%s' "$detail" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"state":"%s","at":%s,"detail":"%s"}' "$state" "$when" "$detail"
}

write_status_json() {
  [ -d "${DATA}" ] || return 0
  load_settings
  printf '{"maxAgeHours":%s,"startedAt":%s,"backup":%s,"verify":%s}\n' \
    "$(max_age_hours)" "$(cat "${STATUS_DIR}/started" 2>/dev/null || echo 0)" \
    "$(status_entry backup)" "$(status_entry verify)" \
    > "${STATUS_JSON}.tmp" 2>/dev/null && mv "${STATUS_JSON}.tmp" "${STATUS_JSON}" || true
}

ping_health() {
  [ -n "${HEALTHCHECK_URL:-}" ] || return 0
  local suffix=""
  [ "${1:-}" = "fail" ] && suffix="/fail"
  curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}${suffix}" >/dev/null 2>&1 || true
}

# Interval and retention can be changed in Homebox (Collection → Tools), which
# writes them next to the database. Without that file the env values apply.
SETTINGS_JSON="${DATA}/.hb-backup-settings.json"
INTERVAL_DAYS="${BACKUP_INTERVAL_DAYS:-1}"
KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-}"

load_settings() {
  [ -f "${SETTINGS_JSON}" ] || return 0
  local v
  v="$(grep -o '"intervalDays":[0-9]*' "${SETTINGS_JSON}" | cut -d: -f2)"
  [ -n "$v" ] && [ "$v" -ge 1 ] && INTERVAL_DAYS="$v"
  v="$(grep -o '"keepMonths":[0-9]*' "${SETTINGS_JSON}" | cut -d: -f2)"
  [ -n "$v" ] && [ "$v" -ge 1 ] && KEEP_MONTHS="$v"
  return 0
}

# How old the last successful backup may get before it counts as "stopped".
max_age_hours() {
  echo "${BACKUP_MAX_AGE_HOURS:-$(( INTERVAL_DAYS * 24 + 12 ))}"
}

# Scheduled runs happen daily; skip until INTERVAL_DAYS have passed since the
# last successful backup (with a few hours of slack for timing jitter).
backup_due() {
  [ -f "${STATUS_DIR}/backup" ] || return 0
  local state when
  read -r state when _ < "${STATUS_DIR}/backup"
  [ "$state" = ok ] || return 0
  [ $(( $(date +%s) - when )) -ge $(( INTERVAL_DAYS * 86400 - 4 * 3600 )) ]
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
  load_settings
  if [ "${1:-}" = "--scheduled" ] && ! backup_due; then
    log "skipping: last backup is younger than ${INTERVAL_DAYS} day(s)"
    return 0
  fi
  STATUS_FOR=backup
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
    echo "files=$(find "${DATA}" -type f ! -name "${DB_NAME}*" ! -name '.hb-backup-status.json*' ! -path '*/.pre-restore-*' | wc -l)"
  } > "${work}/BACKUP-INFO"

  tar -czf "${work}/${name}" \
    -C "${DATA}" \
    --exclude="./${DB_NAME}" --exclude="./${DB_NAME}-wal" --exclude="./${DB_NAME}-shm" \
    --exclude='./.pre-restore-*' --exclude='./.hb-backup-status.json*' \
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
  write_status ok "${name}"
  ping_health
}

# Delete remote backups older than KEEP_MONTHS (or BACKUP_KEEP_DAYS), but always
# keep the newest BACKUP_KEEP_MIN — if backups silently stopped, old ones must
# not run out.
rotate() {
  local keep_min="${BACKUP_KEEP_MIN:-10}" keep_days="${BACKUP_KEEP_DAYS:-60}"
  local cutoff all count age
  if [ -n "${KEEP_MONTHS}" ]; then
    cutoff="$(date -u -d "-${KEEP_MONTHS} months" '+%Y%m%d-%H%M%S')"
    age="${KEEP_MONTHS} months"
  else
    cutoff="$(date -u -d "-${keep_days} days" '+%Y%m%d-%H%M%S')"
    age="${keep_days} days"
  fi
  all="$(remote_list)"
  count="$(echo "$all" | grep -c . || true)"
  echo "$all" | head -n "-${keep_min}" | while read -r f; do
    [ -n "$f" ] || continue
    local ts="${f#${PREFIX}-}"; ts="${ts%.tar.gz}"
    if [[ "$ts" < "$cutoff" ]]; then
      rclone deletefile "${CRYPT}${f}" && log "rotated out ${f}"
    fi
  done
  log "${count} backup(s) on remote before rotation (keep >= ${keep_min}, max age ${age})"
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

# Restore test: download, decrypt and unpack a backup into a temporary folder
# and check it like a restore would, without touching /data. Runs monthly.
cmd_verify() {
  local target="latest" arg
  for arg in "$@"; do
    case "$arg" in
      --remote) export HB_PREFER_REMOTE=true ;;
      *) target="$arg" ;;
    esac
  done
  STATUS_FOR=verify
  setup_crypt
  local name work
  name="$(resolve_name "$target")"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  fetch_backup "$name" "$work"

  local entities files want_files
  entities="$(sqlite3 "${work}/x/${DB_NAME}" "SELECT count(*) FROM entities;" 2>/dev/null)" \
    || die "backup ${name}: database has no readable entities table"
  files="$(find "${work}/x" -type f ! -name "${DB_NAME}" ! -name BACKUP-INFO | wc -l)"
  want_files="$(grep '^files=' "${work}/x/BACKUP-INFO" 2>/dev/null | cut -d= -f2)"
  if [ -n "$want_files" ] && [ "$files" -lt "$want_files" ]; then
    die "backup ${name}: ${files} of ${want_files} photo/attachment files present"
  fi
  log "restore test OK: ${name} – database intact, ${entities} entries, ${files} photo/attachment files"
  write_status ok "${name} (${entities} entries, ${files} files)"
}

cmd_status() {
  local kind state when detail
  for kind in backup verify; do
    if [ -f "${STATUS_DIR}/${kind}" ]; then
      read -r state when detail < "${STATUS_DIR}/${kind}"
      printf '%-7s %-4s %s  %s\n' "$kind" "$state" "$(date -d "@${when}" '+%F %T')" "$detail"
    else
      printf '%-7s %s\n' "$kind" "never ran"
    fi
  done
  write_status_json
}

# Unhealthy when the last backup or restore test failed, or when no backup has
# succeeded for longer than the interval allows (cron stopped, container paused).
cmd_health() {
  load_settings
  local max_age=$(( $(max_age_hours) * 3600 )) now state when detail since
  now="$(date +%s)"
  if [ -f "${STATUS_DIR}/verify" ]; then
    read -r state when detail < "${STATUS_DIR}/verify"
    [ "$state" = ok ] || { echo "restore test failed: ${detail}"; exit 1; }
  fi
  if [ -f "${STATUS_DIR}/backup" ]; then
    read -r state when detail < "${STATUS_DIR}/backup"
    [ "$state" = ok ] || { echo "last backup failed: ${detail}"; exit 1; }
    since="$when"
  else
    since="$(cat "${STATUS_DIR}/started" 2>/dev/null || echo "$now")"
  fi
  [ $(( now - since )) -le "$max_age" ] || { echo "no successful backup for more than $(max_age_hours) hours"; exit 1; }
  echo "healthy"
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

# --- pre-update snapshots ----------------------------------------------------
# The stack runs "snapshot" in a one-shot container that Homebox waits for, so
# a copy of the database exists from right before every (re)start — before an
# updated image migrates the database. Local only (no OneDrive), fast, and it
# never fails: a problem here must not keep Homebox from starting.
SNAP_DIR="${LOCAL}/pre-update"

cmd_snapshot() {
  local keep="${PRE_UPDATE_KEEP:-5}" stamp file
  if [ ! -f "${DATA}/${DB_NAME}" ]; then
    log "snapshot: no database at ${DATA}/${DB_NAME} yet – nothing to save"
    return 0
  fi
  mkdir -p "${SNAP_DIR}" || { log "snapshot: cannot create ${SNAP_DIR} – skipped"; return 0; }
  stamp="$(date -u '+%Y%m%d-%H%M%S')"
  file="${SNAP_DIR}/${PREFIX}-${stamp}.db"
  if ! sqlite3 "${DATA}/${DB_NAME}" ".timeout 30000" ".backup '${file}'" 2>/dev/null; then
    rm -f "${file}"
    log "snapshot: WARNING – could not copy the database, Homebox starts without a pre-update copy"
    return 0
  fi
  if [ "$(sqlite3 "${file}" "PRAGMA integrity_check;" 2>&1 | head -n1)" != "ok" ]; then
    rm -f "${file}"
    log "snapshot: WARNING – copy failed the integrity check, removed"
    return 0
  fi
  gzip -f "${file}" || true
  ls -1 "${SNAP_DIR}"/${PREFIX}-*.db.gz 2>/dev/null | sort | head -n "-${keep}" | xargs -r rm -f
  log "snapshot: saved $(basename "${file}").gz ($(du -h "${file}.gz" 2>/dev/null | cut -f1)), keeping the last ${keep}"
  return 0
}

cmd_snapshots() {
  ls -1sh "${SNAP_DIR}"/${PREFIX}-*.db.gz 2>/dev/null | sort -k2 || echo "no pre-update snapshots in ${SNAP_DIR}"
}

cmd_restore_snapshot() {
  local target="latest" yes=false file stamp aside
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) yes=true ;;
      *) target="$arg" ;;
    esac
  done
  if [ "$target" = latest ]; then
    file="$(ls -1 "${SNAP_DIR}"/${PREFIX}-*.db.gz 2>/dev/null | sort | tail -n1)"
  else
    file="${SNAP_DIR}/${target%.gz}.gz"
    [ -f "$file" ] || file="${SNAP_DIR}/${target}"
  fi
  [ -n "$file" ] && [ -f "$file" ] || { log "ERROR: no snapshot '${target}' in ${SNAP_DIR} (see 'hb-backup snapshots')"; exit 1; }

  if [ "$yes" != true ]; then
    echo "This replaces the Homebox database with $(basename "$file") (photos and attachments stay)."
    echo "The current database is moved aside to ${DATA}/.pre-restore-<timestamp> (not deleted)."
    echo "Stop the Homebox container first, then run:  hb-backup restore-snapshot $(basename "$file") --yes"
    exit 2
  fi
  if homebox_running; then
    log "ERROR: Homebox is still running at ${HOMEBOX_URL} – stop the homebox container first"
    exit 1
  fi

  stamp="$(date '+%Y%m%d-%H%M%S')"
  aside="${DATA}/.pre-restore-${stamp}"
  mkdir -p "$aside"
  mv "${DATA}/${DB_NAME}" "${DATA}/${DB_NAME}-wal" "${DATA}/${DB_NAME}-shm" "$aside/" 2>/dev/null || true
  log "current database moved to ${aside}"
  gunzip -c "$file" > "${DATA}/${DB_NAME}"
  check_db "${DATA}/${DB_NAME}"
  log "restored $(basename "$file"). Start the homebox container again (with the image version from before the update)."
}

cmd_help() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-help}" in
  backup) shift; cmd_backup "${1:-}" ;;
  list) cmd_list ;;
  verify) shift; cmd_verify "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  snapshot) cmd_snapshot ;;
  snapshots) cmd_snapshots ;;
  restore-snapshot) shift; cmd_restore_snapshot "$@" ;;
  check) cmd_check ;;
  status) cmd_status ;;
  health) cmd_health ;;
  help|-h|--help) cmd_help ;;
  *) echo "unknown command: $1"; cmd_help; exit 1 ;;
esac
