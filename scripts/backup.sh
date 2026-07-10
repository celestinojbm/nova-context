#!/usr/bin/env bash
# Nova Context private-alpha backup (M11; hardened in M15 per Hermes P1).
#
# Backs up the two stateful stores, then SEALS them with authenticated
# encryption and writes an integrity manifest:
#   1. Postgres      → pg_dump custom-format archive  → AES-256-GCM .enc
#   2. Media objects → tar of the fs store root       → AES-256-GCM .enc
#   3. manifest-<stamp>.json (sha256 + sizes + timestamp; NO secrets)
#
# Keys, deliberately:
#   - NOVA_BACKUP_KEY  seals the backup. It is SEPARATE from the data key and
#     is NEVER written into the backup. Store it in your secret manager.
#   - NOVA_ENCRYPTION_KEY (data at rest) is likewise NOT in the backup: media
#     blobs and integration tokens stay AES-256-GCM ciphertext. A backup
#     WITHOUT the data key restores metadata only.
# There is NO plaintext-backup path: without NOVA_BACKUP_KEY this fails.
# Redis is not backed up (retryable queue work only).
#
# Usage:
#   NOVA_BACKUP_KEY=<hex32> DATABASE_URL=postgres://... \
#     NOVA_MEDIA_FS_ROOT=/data/media scripts/backup.sh /backups
#
# Verify:  NOVA_BACKUP_KEY=... pnpm --filter @nova/api backup:verify -- \
#            --dir=/backups --stamp=<stamp>
set -euo pipefail
umask 077   # every file/dir this script creates is owner-only

DEST="${1:?usage: backup.sh <destination-dir>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -z "${NOVA_BACKUP_KEY:-}" ]; then
  echo "ERROR: NOVA_BACKUP_KEY is required — backups are always encrypted." >&2
  echo "  Generate a SEPARATE key (openssl rand -hex 32) and keep it in your" >&2
  echo "  secret store, NOT alongside the backup or the data key." >&2
  exit 1
fi

mkdir -p "$DEST"
chmod 700 "$DEST"
# Refuse to write into a world/group-accessible directory.
PERMS="$(stat -c '%a' "$DEST" 2>/dev/null || stat -f '%A' "$DEST")"
case "$PERMS" in
  700|0700) : ;;
  *) echo "ERROR: backup dir $DEST has permissions $PERMS; refusing (want 700)." >&2; exit 1 ;;
esac

echo "→ Postgres dump"
pg_dump --format=custom --file="$DEST/nova-db-$STAMP.dump" "${DATABASE_URL:?DATABASE_URL required}"

if [ -n "${NOVA_MEDIA_FS_ROOT:-}" ] && [ -d "${NOVA_MEDIA_FS_ROOT}" ]; then
  echo "→ Media store tar (${NOVA_MEDIA_FS_ROOT})"
  tar -czf "$DEST/nova-media-$STAMP.tar.gz" -C "$NOVA_MEDIA_FS_ROOT" .
else
  echo "→ Media store: NOVA_MEDIA_FS_ROOT not set or missing — skipping"
  echo "  (s3 store: rely on bucket versioning/replication + SSE instead)"
fi

echo "→ Sealing artifacts (AES-256-GCM) + manifest"
# The seal step encrypts each artifact, deletes the plaintext, and writes the
# manifest. It fails closed if NOVA_BACKUP_KEY is missing/invalid.
pnpm --filter @nova/api --silent backup:seal -- --dir="$DEST" --stamp="$STAMP" --created-at="$CREATED_AT"

echo "Backup complete: $DEST (sealed db + media as of $STAMP)"
echo "REMINDER: NOVA_BACKUP_KEY and NOVA_ENCRYPTION_KEY live in your secret store, NOT here."
