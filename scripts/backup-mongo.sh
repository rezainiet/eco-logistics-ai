#!/usr/bin/env bash
#
# MongoDB backup helper.
#
# Wraps `mongodump` with sensible defaults so a cron entry like
#   15 3 * * *  /opt/ecom/scripts/backup-mongo.sh >> /var/log/ecom-backup.log 2>&1
# is sufficient. Designed to be run on the application host or on a small
# dedicated backup VM with read-only DB credentials.
#
# Required env:
#   MONGODB_URI            Standard mongodb:// or mongodb+srv:// connection
#                          string. Read-only credentials recommended.
#   BACKUP_DIR             Directory to write archives to (created if absent).
#
# Optional env:
#   BACKUP_RETENTION_DAYS  Days to keep local archives (default 14).
#   BACKUP_S3_URI          If set, archive is uploaded via `aws s3 cp` after a
#                          successful dump (e.g. s3://my-bucket/ecom/).
#   AWS_PROFILE / AWS_REGION pass-through for the AWS CLI.
#
# Exits non-zero on any failure so cron MAILTO catches it.

set -euo pipefail

: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/ecom-mongo-$STAMP.archive.gz"

echo "[backup] starting $STAMP -> $ARCHIVE"

# `--archive` writes a single binary stream so restore is `mongorestore --archive=...`.
# `--gzip` compresses inline. Combined they produce a portable, ~80% smaller file.
mongodump \
  --uri="$MONGODB_URI" \
  --archive="$ARCHIVE" \
  --gzip \
  --quiet

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "[backup] dump complete ($SIZE)"

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  TARGET="${BACKUP_S3_URI%/}/ecom-mongo-$STAMP.archive.gz"
  echo "[backup] uploading -> $TARGET"
  aws s3 cp "$ARCHIVE" "$TARGET" --no-progress
fi

# Local retention sweep — drops anything older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f -name "ecom-mongo-*.archive.gz" \
  -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] done"
