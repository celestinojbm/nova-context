# Operator runbooks (M13)

Command-oriented, one scenario per section. Everything here runs from the
repo checkout with the target environment's `DATABASE_URL` (plus
`NOVA_ENCRYPTION_KEY` where blobs/tokens are touched). On Fly, prefix with
`fly ssh console -c <config> -C "..."` or set the env locally against the
production database. Alpha user–facing docs live in `docs/ALPHA_GUIDE.md`;
deploy details in `infra/DEPLOY.md`.

## Deploy

```bash
pnpm --filter @nova/api ops:preflight          # with production env set — must print PREFLIGHT OK
fly deploy -c infra/deploy/fly.api.toml        # release step runs migrations
fly deploy -c infra/deploy/fly.worker.toml
fly deploy -c infra/deploy/fly.web.toml
pnpm --filter @nova/api ops:smoke -- --base-url=https://<api-host> --invite=<code>
pnpm --filter @nova/api ops:maintenance        # dry run — sane counts?
```

## Rollback

```bash
fly releases -c infra/deploy/fly.api.toml      # find the previous image
fly deploy  -c infra/deploy/fly.api.toml --image <previous-image-ref>
```
Migrations are forward-only: never roll the schema back — ship a correcting
migration. Blobs/tokens are unaffected by app rollbacks (same key, format).

## Backup (M15: sealed + verified)

```bash
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=... NOVA_MEDIA_FS_ROOT=... \
  scripts/backup.sh <dest-dir>
# verify (hash-only without the key; +decrypt with it):
NOVA_BACKUP_KEY=... pnpm --filter @nova/api backup:verify -- \
  --dir=<dest-dir> --stamp=<stamp>
```
Artifacts are AES-256-GCM sealed (`*.enc`) with `NOVA_BACKUP_KEY` — a
SEPARATE key from the data key, never written into the backup — plus a
`manifest-<stamp>.json` (sha256 + sizes, no secrets). `umask 077`: dir
`700`, files `600`. There is NO plaintext-backup path: without the key the
script fails. s3 media: rely on bucket versioning + SSE.

## Restore (M15: guarded)

```bash
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=... NOVA_MEDIA_FS_ROOT=... \
  NOVA_ENCRYPTION_KEY=<data-key> scripts/restore.sh <backup-dir> <stamp>
```
Destructive (`pg_restore --clean`). Guardrails: typed `RESTORE` confirm
(or `NOVA_RESTORE_CONFIRM=RESTORE`); refuses a production-looking target
without `NOVA_RESTORE_ALLOW_PRODUCTION=yes`; `backup:verify` (manifest +
decrypt) BEFORE touching the DB; unseal → restore → `db:migrate` no-op +
`media:verify` + smoke reminder. Without the DATA key: metadata restores;
media/tokens stay ciphertext. Redis not restored (retryable work only):
re-approve in-flight actions; enrichment re-runs append versions.

## Backup policy (M15)

- **What:** Postgres (all metadata + encrypted tokens) and fs media
  (encrypted blobs). Redis is NOT backed up (retryable queue work only).
- **Retention:** keep ≥14 daily backups for the alpha; prune older with a
  cron that deletes whole `<stamp>` sets (both `*.enc` + the manifest).
- **Location:** an access-controlled store SEPARATE from the running
  hosts (e.g. a private, versioned object bucket). Never on the same
  volume as the media store.
- **Deletion:** delete a backup by removing its `*.enc` files AND its
  manifest together; a sealed artifact is unreadable without the key, so
  there is no plaintext to shred.
- **Keys:** `NOVA_BACKUP_KEY` (seals backups) and `NOVA_ENCRYPTION_KEY`
  (data at rest) live ONLY in your secret manager — never in a backup,
  never in the repo, never in logs. Losing `NOVA_BACKUP_KEY` makes
  backups unrecoverable; losing `NOVA_ENCRYPTION_KEY` makes a restore
  metadata-only.
- **What cannot be restored without keys:** media blobs and integration
  tokens (need the data key); nothing at all (need the backup key). A
  restorer with neither recovers nothing readable — no unredacted content
  is ever exposed.
- **Restore drill (quarterly):** `backup.sh` → `backup:verify` →
  `restore.sh` into a SCRATCH database (`nova_restore`) → `media:verify`
  → `ops:smoke` against a throwaway instance. Confirm wrong-key
  `backup:verify` fails (`decrypt:fail`).

## Rotate the media/token key (zero-downtime)

```bash
# 1. deploy API+worker with NOVA_ENCRYPTION_KEY=<new> NOVA_ENCRYPTION_KEYS_PREVIOUS=<old>
# 2. re-encrypt gradually (resumable; re-run until undecryptable: 0):
NOVA_ENCRYPTION_KEY=<new> NOVA_ENCRYPTION_KEY_OLD=<old> \
  pnpm --filter @nova/api media:rotate-key -- --apply
# 3. verify with ONLY the new key, then remove PREVIOUS and redeploy:
pnpm --filter @nova/api media:verify
```
`ops:preflight` warns while PREVIOUS keys linger — that is the reminder.

## Clean up orphan media

```bash
pnpm --filter @nova/api media:cleanup                 # dry run (default)
pnpm --filter @nova/api media:cleanup -- --delete     # apply
```
`--min-age-minutes` (default 60) protects in-flight captures. Referenced
media is structurally untouchable.

## Drain the media delete queue

Same command — `media:cleanup -- --delete` retries every tombstoned delete.
Trigger: `pending_media_deletes > 0` on /status or in `ops:report`.

## Reset a password

```bash
pnpm --filter @nova/api auth:reset-token -- <email>   # prints a one-time link, 30-min TTL
# or set one directly:
pnpm --filter @nova/api auth:reset-password -- <email>
```
In production `auth:reset-token` requires `NOVA_OPERATOR_RESET=yes`.
Deliver the link out-of-band; completing it revokes all sessions.

## Revoke sessions

User-side: Settings → Sessions (or Sign out everywhere). Operator-side, all
sessions for an account:

```bash
psql "$DATABASE_URL" -c "DELETE FROM sessions WHERE user_id = \
  (SELECT id FROM users WHERE email = '<email>')"
```

## Disconnect Notion

User-side: Settings → Integrations → Disconnect (wipes the ciphertext).
Operator-side (e.g. compromised workspace):

```bash
psql "$DATABASE_URL" -c "UPDATE integrations SET status='revoked', \
  token_ciphertext=NULL WHERE provider='notion' AND user_id = \
  (SELECT id FROM users WHERE email='<email>')"
```
Also revoke the grant in Notion (Settings → My connections).

## Investigate worker failures

```bash
fly logs -c infra/deploy/fly.worker.toml               # structured; job_id/action_id/error_class
pnpm --filter @nova/api ops:report                     # failed counts + recent reasons
```
`/status` worker `last_beat` stale → worker down or Redis unreachable;
restart the worker, BullMQ resumes queued jobs. Enrichment failures are
per-moment (`enrichment_status='failed'`) and retried by BullMQ; approvals
are never lost by a worker restart.

## Investigate failed actions

```bash
pnpm --filter @nova/api ops:report        # friction.recent_failed_actions: id + reason
```
Terminal reasons (`revoked token`, `unshared page`, `mapping invalid`) need
the user: reconnect Notion / re-share the destination / fix the mapping in
Settings, then re-approve from the web app. Transient reasons retried
automatically (check queue `failed` count on /status for exhausted retries).

## Investigate missing media

```bash
pnpm --filter @nova/api media:verify      # verified / missing / undecryptable per blob
```
- `missing` → storage lost objects: restore media backup, then re-verify.
- `undecryptable` → wrong/missing key: restore the right key or add the old
  one to `NOVA_ENCRYPTION_KEYS_PREVIOUS`, finish rotation.
- Timeline shows `media_unavailable` at capture time → pipeline was down
  (no key/store): nothing was stored, by design; check `/readyz`.

## Investigate "search doesn't find my moment"

```bash
# 1. does the moment exist and carry text? (ocr_text is masked-safe)
psql "$DATABASE_URL" -c "SELECT id, left(extracted_text,80), enrichment_status \
  FROM context_moments WHERE user_id=(SELECT id FROM users WHERE email='<email>') \
  ORDER BY captured_at DESC LIMIT 10"
# 2. run the search with diagnostics (as the user, via API):
#    POST /v1/memory/search {"query":"...", "debug":true} → per-leg ranks
```
Common causes: word only in a masked region (correct behavior — masked
values are unreachable); embeddings leg off (no OPENAI_API_KEY) → keyword
only; enrichment still queued (worker down) → no summary/embedding yet;
prefix shorter than the stemmed token (search v2 falls back automatically).

## Alpha triage loop (weekly)

```bash
pnpm --filter @nova/api ops:report                    # usage, friction, feedback, warnings
pnpm --filter @nova/api ops:maintenance               # dry run; -- --apply after review
psql "$DATABASE_URL" -c "UPDATE alpha_feedback SET status='triaged' WHERE id='<id>'"
```
