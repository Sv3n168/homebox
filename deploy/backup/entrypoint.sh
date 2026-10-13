#!/bin/bash
# schedule (default): run hb-backup on BACKUP_SCHEDULE via crond, logging to
# the container log. Anything else is passed to hb-backup (backup, list,
# verify, restore, ...) or run as a command (e.g. "rclone config").
set -euo pipefail

if [ "${1:-schedule}" != "schedule" ]; then
  case "$1" in
    backup|list|verify|restore|check|help) exec /usr/local/bin/hb-backup "$@" ;;
    *) exec "$@" ;;
  esac
fi

# busybox crond starts jobs with an empty environment: hand ours over.
export -p > /etc/hb-backup.env

/usr/local/bin/hb-backup check || echo "hb-backup: setup incomplete – see 'hb-backup help'. Waiting for the schedule anyway."

echo "${BACKUP_SCHEDULE} /usr/local/bin/hb-backup backup > /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "hb-backup: scheduled '${BACKUP_SCHEDULE}' (TZ=${TZ}) -> ${BACKUP_REMOTE} (encrypted)"

if [ "${BACKUP_ON_START:-false}" = "true" ]; then
  /usr/local/bin/hb-backup backup || true
fi

exec crond -f -l 8
