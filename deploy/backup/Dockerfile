# Encrypted off-site backups of the Homebox data volume (database + photos and
# attachments) to OneDrive — or any other rclone remote. See deploy/README.md.
FROM rclone/rclone:1.71.1

RUN apk add --no-cache bash sqlite tar gzip tzdata curl coreutils

COPY hb-backup.sh /usr/local/bin/hb-backup
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/hb-backup /entrypoint.sh

ENV RCLONE_CONFIG=/config/rclone.conf \
    HB_DATA_DIR=/data \
    HB_LOCAL_DIR=/backups \
    BACKUP_REMOTE=onedrive:Backups/homebox \
    BACKUP_SCHEDULE="30 3 * * *" \
    VERIFY_SCHEDULE="15 4 1 * *" \
    BACKUP_KEEP_DAYS=60 \
    BACKUP_KEEP_MIN=10 \
    BACKUP_LOCAL_KEEP=3 \
    TZ=Europe/Berlin

VOLUME ["/config", "/backups"]
# Portainer shows the container as "unhealthy" when backups stopped or a
# backup / restore test failed.
HEALTHCHECK --interval=30m --timeout=30s --start-period=5m CMD ["/usr/local/bin/hb-backup", "health"]
ENTRYPOINT ["/entrypoint.sh"]
CMD ["schedule"]
