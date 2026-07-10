#!/usr/bin/env bash
# Nova Context private-alpha backup (M11).
#
# Backs up the two stateful stores:
#   1. Postgres      → pg_dump custom-format archive
#   2. Media objects → tar of the fs store root (skip when NOVA_MEDIA_STORE=s3;
#                      use your provider's bucket versioning/replication there)
#
# The ENCRYPTION KEY IS NOT PART OF THE BACKUP by design — store
# NOVA_ENCRYPTION_KEY (and any NOVA_ENCRYPTION_KEYS_PREVIOUS) in your
# password manager / secret store. Media blobs and integration tokens are
# AES-256-GCM ciphertext: a backup without the key restores METADATA ONLY.
# Redis is deliberately NOT backed up: queues hold retryable jobs; after a
# restore, re-approve any in-flight action and re-run enrichment as needed.
#
# Usage:
#   DATABASE_URL=postgres://... NOVA_MEDIA_FS_ROOT=/data/media \
#     scripts/backup.sh /backups
#
# Verify a restore with:
#   pnpm --filter @nova/api db:migrate       # no-op when schema is current
#   pnpm --filter @nova/api media:verify     # every blob present + decryptable
set -euo pipefail

DEST="${1:?usage: backup.sh <destination-dir>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"

echo "→ Postgres dump"
pg_dump --format=custom --file="$DEST/nova-db-$STAMP.dump" "${DATABASE_URL:?DATABASE_URL required}"

if [ -n "${NOVA_MEDIA_FS_ROOT:-}" ] && [ -d "${NOVA_MEDIA_FS_ROOT}" ]; then
  echo "→ Media store tar (${NOVA_MEDIA_FS_ROOT})"
  tar -czf "$DEST/nova-media-$STAMP.tar.gz" -C "$NOVA_MEDIA_FS_ROOT" .
else
  echo "→ Media store: NOVA_MEDIA_FS_ROOT not set or missing — skipping"
  echo "  (s3 store: rely on bucket versioning/replication instead)"
fi

echo "Backup complete: $DEST (db + media as of $STAMP)"
echo "REMINDER: the encryption key lives in your secret store, NOT here."
