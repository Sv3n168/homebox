#!/bin/bash
# schedule (default): run hb-backup on BACKUP_SCHEDULE and the restore test on
# VERIFY_SCHEDULE via crond, logging to the container log. Anything else is passed to hb-backup (backup, list,
# verify, restore, ...) or run as a command (e.g. "rclone config").
set -euo pipefail

if [ "${1:-schedule}" != "schedule" ]; then
  case "$1" in
    backup|list|verify|restore|check|status|health|help|snapshot|snapshots|restore-snapshot) exec /usr/local/bin/hb-backup "$@" ;;
    *) exec "$@" ;;
  esac
fi

# busybox crond starts jobs with an empty environment: hand ours over.
export -p > /etc/hb-backup.env

/usr/local/bin/hb-backup check || echo "hb-backup: setup incomplete – see 'hb-backup help'. Waiting for the schedule anyway."

# The health check counts from here until the first backup has run.
mkdir -p "${HB_LOCAL_DIR}/.status" && date +%s > "${HB_LOCAL_DIR}/.status/started" || true
# Lets Homebox show "backup container running, no backup yet" right away.
/usr/local/bin/hb-backup status || true

{
  # Daily; hb-backup skips the run until the interval set in Homebox is due.
  echo "${BACKUP_SCHEDULE} /usr/local/bin/hb-backup backup --scheduled > /proc/1/fd/1 2>&1"
  # Monthly restore test of the off-site copy (download, decrypt, check).
  echo "${VERIFY_SCHEDULE} /usr/local/bin/hb-backup verify latest --remote > /proc/1/fd/1 2>&1"
} > /etc/crontabs/root
echo "hb-backup: scheduled '${BACKUP_SCHEDULE}' (TZ=${TZ}) -> ${BACKUP_REMOTE} (encrypted)"
echo "hb-backup: restore test scheduled '${VERIFY_SCHEDULE}'"

if [ "${BACKUP_ON_START:-false}" = "true" ]; then
  /usr/local/bin/hb-backup backup || true
fi

exec crond -f -l 8
