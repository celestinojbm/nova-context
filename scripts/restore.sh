#!/usr/bin/env bash
# Nova Context — restore from a scripts/backup.sh backup (M13).
#
#   DATABASE_URL=postgres://... NOVA_MEDIA_FS_ROOT=./var/media \
#     scripts/restore.sh <backup-dir> <stamp>
#
# where <backup-dir> holds nova-db-<stamp>.dump and nova-media-<stamp>.tar.gz
# (as produced by scripts/backup.sh). s3 media deploys skip the tar step —
# use bucket versioning/replication instead.
#
# KEYS ARE NOT IN THE BACKUP, deliberately. Restore NOVA_ENCRYPTION_KEY from
# your secret store BEFORE verifying: without it the restore recovers
# metadata only — media blobs and integration tokens stay unreadable
# ciphertext (media can be re-captured; Notion can be reconnected; nothing
# unredacted is ever exposed, even to the restorer).
#
# Redis is NOT backed up: queues carry retryable work only. After restore,
# re-approve any in-flight external action; enrichment re-runs append
# versions (M10), never overwrite.
set -euo pipefail

BACKUP_DIR="${1:?usage: restore.sh <backup-dir> <stamp>}"
STAMP="${2:?usage: restore.sh <backup-dir> <stamp>}"
: "${DATABASE_URL:?DATABASE_URL is required}"

DB_DUMP="$BACKUP_DIR/nova-db-$STAMP.dump"
MEDIA_TAR="$BACKUP_DIR/nova-media-$STAMP.tar.gz"

[ -f "$DB_DUMP" ] || { echo "missing $DB_DUMP" >&2; exit 1; }

echo "== restoring Postgres from $DB_DUMP"
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$DB_DUMP"

if [ -f "$MEDIA_TAR" ]; then
  : "${NOVA_MEDIA_FS_ROOT:?NOVA_MEDIA_FS_ROOT is required to restore fs media}"
  echo "== restoring media blobs into $NOVA_MEDIA_FS_ROOT"
  mkdir -p "$NOVA_MEDIA_FS_ROOT"
  tar -xzf "$MEDIA_TAR" -C "$NOVA_MEDIA_FS_ROOT"
else
  echo "== no media tar for stamp $STAMP (s3 deploy or media-less backup) — skipping"
fi

echo "== verifying"
echo "   1. migrations are current (should no-op):"
pnpm --filter @nova/api db:migrate
echo "   2. every blob present AND decryptable with the configured key:"
pnpm --filter @nova/api media:verify
echo "== restore complete. Finish with the post-deploy smoke:"
echo "   pnpm --filter @nova/api ops:smoke -- --base-url=<api-url> [--invite=<code>]"
