#!/usr/bin/env bash
# Nova Context restore (M13; hardened in M15 + M15B per Hermes).
#
#   NOVA_BACKUP_KEY=<hex32> DATABASE_URL=postgres://... \
#     NOVA_MEDIA_FS_ROOT=./var/media NOVA_ENCRYPTION_KEY=<data-key> \
#     scripts/restore.sh <backup-dir> <stamp>
#
# This is DESTRUCTIVE (pg_restore --clean drops and recreates objects).
# Guardrails, in order:
#   1. explicit typed confirmation (unless NOVA_RESTORE_CONFIRM=RESTORE);
#   2. target check (M15B/D03): ONLY a loopback host in a non-production
#      environment is "local scratch"; ANY remote/non-loopback target —
#      including a db named nova_alpha on a remote host — requires
#      NOVA_RESTORE_ALLOW_PRODUCTION=yes. The DATABASE_URL is NEVER printed;
#      only a credential-redacted target is shown;
#   3. manifest + decryption verification BEFORE touching the database;
#   4. unseal (decrypt) into a temp dir, restore;
#   5. post-restore verification: db:migrate no-op + media:verify + smoke.
#
# KEYS: NOVA_BACKUP_KEY unseals the backup; NOVA_ENCRYPTION_KEY is still
# required afterwards to read media/tokens. Without the data key the restore
# recovers metadata only — media blobs and tokens stay unreadable ciphertext.
set -euo pipefail
umask 077

BACKUP_DIR="${1:?usage: restore.sh <backup-dir> <stamp>}"
STAMP="${2:?usage: restore.sh <backup-dir> <stamp>}"
: "${DATABASE_URL:?DATABASE_URL is required}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${NOVA_BACKUP_KEY:-}" ]; then
  echo "ERROR: NOVA_BACKUP_KEY is required to unseal this backup." >&2
  exit 1
fi

# --- Guardrail 2 (first): classify the target (redacted; never raw DSN) ------
set +e
GUARD_OUT="$( cd "$REPO_ROOT" && pnpm --filter @nova/api --silent backup:restore-guard )"
GUARD_CODE=$?
set -e
echo "$GUARD_OUT"   # prints only "target: scheme://***@host/db"
if [ "$GUARD_CODE" -eq 2 ]; then echo "ERROR: bad DATABASE_URL." >&2; exit 1; fi
if [ "$GUARD_CODE" -eq 3 ] && [ "${NOVA_RESTORE_ALLOW_PRODUCTION:-}" != "yes" ]; then
  echo "ERROR: target is not a local scratch database. Refusing without" >&2
  echo "  NOVA_RESTORE_ALLOW_PRODUCTION=yes (set it ONLY if you mean it)." >&2
  exit 1
fi

# --- Guardrail 1: destructive confirmation -----------------------------------
if [ "${NOVA_RESTORE_CONFIRM:-}" != "RESTORE" ]; then
  echo "This will DESTRUCTIVELY restore into the target shown above."
  printf 'Type RESTORE to proceed: '
  read -r reply
  if [ "$reply" != "RESTORE" ]; then echo "Aborted." >&2; exit 1; fi
fi

# --- Guardrail 3: verify the backup BEFORE touching the DB -------------------
echo "== verifying backup (manifest HMAC + sha256 + decryptability)"
( cd "$REPO_ROOT" && pnpm --filter @nova/api --silent backup:verify -- --dir="$BACKUP_DIR" --stamp="$STAMP" )

# --- Unseal into a temp workspace -------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
chmod 700 "$WORK"

DB_ENC="$BACKUP_DIR/nova-db-$STAMP.dump.enc"
MEDIA_ENC="$BACKUP_DIR/nova-media-$STAMP.tar.gz.enc"

if [ ! -f "$DB_ENC" ]; then echo "ERROR: missing sealed Postgres dump for stamp $STAMP" >&2; exit 1; fi
echo "== unsealing Postgres dump"
( cd "$REPO_ROOT" && NOVA_BACKUP_KEY="$NOVA_BACKUP_KEY" pnpm --filter @nova/api --silent exec tsx -e "
import { parseBackupKey, decryptFile } from './src/backup/crypto.js';
const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
await decryptFile('$DB_ENC', '$WORK/db.dump', key);
" ) >/dev/null

echo "== restoring Postgres (pg_restore --clean)"
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$WORK/db.dump"

if [ -f "$MEDIA_ENC" ]; then
  : "${NOVA_MEDIA_FS_ROOT:?NOVA_MEDIA_FS_ROOT is required to restore fs media}"
  echo "== unsealing + restoring media into fs media root"
  ( cd "$REPO_ROOT" && NOVA_BACKUP_KEY="$NOVA_BACKUP_KEY" pnpm --filter @nova/api --silent exec tsx -e "
import { parseBackupKey, decryptFile } from './src/backup/crypto.js';
const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
await decryptFile('$MEDIA_ENC', '$WORK/media.tar.gz', key);
" ) >/dev/null
  mkdir -p "$NOVA_MEDIA_FS_ROOT"; chmod 700 "$NOVA_MEDIA_FS_ROOT"
  tar -xzf "$WORK/media.tar.gz" -C "$NOVA_MEDIA_FS_ROOT"
else
  echo "== no sealed media artifact for stamp $STAMP (s3 deploy or db-only backup) — skipping"
fi

# --- Guardrail 5: post-restore verification ---------------------------------
echo "== post-restore verification"
echo "   1. migrations current (should no-op):"
( cd "$REPO_ROOT" && pnpm --filter @nova/api db:migrate )
echo "   2. every blob present AND decryptable with the data key:"
( cd "$REPO_ROOT" && pnpm --filter @nova/api media:verify )
echo "== restore complete. Finish with the post-deploy smoke:"
echo "   pnpm --filter @nova/api ops:smoke -- --base-url=<api-url> [--invite=<code>]"
