#!/usr/bin/env bash
# Nova Context private-alpha backup (M11; hardened in M15 + M15B per Hermes).
#
# Backs up the two stateful stores, SEALS them with authenticated encryption,
# and writes an integrity manifest:
#   1. Postgres      → pg_dump custom-format archive  → AES-256-GCM .enc
#   2. Media objects → tar of the fs store root       → AES-256-GCM .enc
#   3. manifest-<stamp>.json (sha256 + sizes + HMAC; NO secrets)
#
# M15B (Hermes D02): plaintext dump/tar are written ONLY inside a private
# 0700 temp workspace. Sealed `.enc` + manifest are produced there and moved
# into the final backup dir ONLY after sealing succeeds. A trap wipes the
# temp workspace on EXIT/INT/TERM/ERR, so an interrupted or failed run never
# leaves plaintext anywhere — and the final dir never contains plaintext.
#
# Keys, deliberately:
#   - NOVA_BACKUP_KEY  seals the backup. SEPARATE from the data key, NEVER
#     written into the backup. Store it in your secret manager.
#   - NOVA_ENCRYPTION_KEY (data at rest) is likewise NOT in the backup.
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
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${NOVA_BACKUP_KEY:-}" ]; then
  echo "ERROR: NOVA_BACKUP_KEY is required — backups are always encrypted." >&2
  echo "  Generate a SEPARATE key (openssl rand -hex 32) and keep it in your" >&2
  echo "  secret store, NOT alongside the backup or the data key." >&2
  exit 1
fi
: "${DATABASE_URL:?DATABASE_URL required}"

mkdir -p "$DEST"
chmod 700 "$DEST"
PERMS="$(stat -c '%a' "$DEST" 2>/dev/null || stat -f '%A' "$DEST")"
case "$PERMS" in
  700|0700) : ;;
  *) echo "ERROR: backup dir $DEST has permissions $PERMS; refusing (want 700)." >&2; exit 1 ;;
esac

# Private temp workspace for PLAINTEXT artifacts. Wiped on any exit path.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nova-backup.XXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

echo "→ Postgres dump (private workspace)"
pg_dump --format=custom --file="$WORK/nova-db-$STAMP.dump" "$DATABASE_URL"

# M18A.1: media backup is FAIL-CLOSED for s3 stores. The final "Backup
# complete" line is printed ONLY on the branch that actually backed media up
# (fs tar or committed s3 inventory) or on an explicitly fs-less non-s3 store.
# M18A.1: the media store TYPE is decided by NOVA_MEDIA_STORE, NOT by whether
# a local fs root happens to exist. NOVA_MEDIA_FS_ROOT has a non-empty default
# (./var/media) and is often present in shared env files, so testing the fs
# branch first would let an s3 deployment tar an empty/stale local dir and
# report "complete" while the real s3 media is never backed up. Dispatch on
# NOVA_MEDIA_STORE so the s3 fail-closed guard can never be shadowed.
MEDIA_MODE="none"
if [ "${NOVA_MEDIA_STORE:-fs}" = "s3" ]; then
  # An s3 media store MUST have a configured, separate backup bucket (+
  # credentials). A missing backup bucket terminates the whole backup with
  # non-zero status — it must NEVER silently produce a db-only "complete"
  # backup for an s3 deployment.
  if [ -z "${NOVA_BACKUP_S3_BUCKET:-}" ]; then
    echo "ERROR: NOVA_MEDIA_STORE=s3 but NOVA_BACKUP_S3_BUCKET is not set." >&2
    echo "  Media cannot be backed up. Refusing to publish a db-only backup." >&2
    exit 1
  fi
  echo "→ Media store: s3 — media:backup-s3 into NOVA_BACKUP_S3_BUCKET (two-phase, fail-closed)"
  MEDIA_INV="$WORK/media-inv"
  mkdir -p "$MEDIA_INV"; chmod 700 "$MEDIA_INV"
  # media:backup-s3 fails closed on any missing source / destination-verify
  # failure and only writes the inventory as the committed commit marker.
  ( cd "$REPO_ROOT" && pnpm --filter @nova/api --silent media:backup-s3 -- \
      --stamp="$STAMP" --out="$MEDIA_INV" --apply ) || {
        echo "ERROR: media:backup-s3 did not commit — backup INCOMPLETE. Refusing to complete." >&2
        exit 1; }
  MEDIA_MODE="s3"
elif [ -n "${NOVA_MEDIA_FS_ROOT:-}" ] && [ -d "${NOVA_MEDIA_FS_ROOT}" ]; then
  echo "→ Media store tar (private workspace)"
  tar -czf "$WORK/nova-media-$STAMP.tar.gz" -C "$NOVA_MEDIA_FS_ROOT" .
  MEDIA_MODE="fs"
else
  # fs store with no populated root (nothing captured yet): media backup is a
  # genuine no-op, and this is NOT an s3 store, so it is safe to continue.
  echo "→ Media store: fs root absent/empty — no media to back up"
  MEDIA_MODE="empty"
fi

# Seal FROM the private workspace INTO a staging dir inside it. Only sealed
# artifacts + manifest are produced; plaintext stays in WORK and is trapped.
echo "→ Sealing artifacts (AES-256-GCM) + manifest"
SEALED="$WORK/sealed"
mkdir -p "$SEALED"; chmod 700 "$SEALED"
( cd "$REPO_ROOT" && pnpm --filter @nova/api --silent backup:seal -- \
    --work="$WORK" --out="$SEALED" --stamp="$STAMP" --created-at="$CREATED_AT" )

# Publish ONLY sealed artifacts + manifest into the final dir. If anything
# above failed, we never reach here and the final dir stays plaintext-free.
mv "$SEALED"/*.enc "$SEALED"/manifest-"$STAMP".json "$DEST"/
# M18A: publish the media-backup inventory too (HMAC-authenticated; contains
# object keys + ciphertext hashes only — no secrets, no content).
if [ "$MEDIA_MODE" = "s3" ]; then
  if [ ! -f "$WORK/media-inv/media-inventory-$STAMP.json" ]; then
    echo "ERROR: media inventory missing after media:backup-s3 — backup NOT complete." >&2
    exit 1
  fi
  mv "$WORK/media-inv/media-inventory-$STAMP.json" "$DEST"/
  # M18A.1: verify the committed media backup BEFORE declaring completion.
  echo "→ Verifying committed media backup (inventory MAC + object hashes)"
  ( cd "$REPO_ROOT" && pnpm --filter @nova/api --silent media:verify-backup-s3 -- \
      --stamp="$STAMP" --dir="$DEST" ) || {
        echo "ERROR: media backup verification FAILED — backup NOT trustworthy." >&2
        exit 1; }
fi

case "$MEDIA_MODE" in
  fs)    echo "Backup complete: $DEST (sealed db + fs media tar as of $STAMP)" ;;
  s3)    echo "Backup complete: $DEST (sealed db + verified s3 media backup as of $STAMP)" ;;
  empty) echo "Backup complete: $DEST (sealed db; no media present as of $STAMP)" ;;
  *)     echo "Backup complete: $DEST (sealed db as of $STAMP)" ;;
esac
echo "REMINDER: NOVA_BACKUP_KEY and NOVA_ENCRYPTION_KEY live in your secret store, NOT here."
