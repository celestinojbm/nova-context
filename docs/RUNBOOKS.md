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

## Backup (M15/M15B: sealed + authenticated + verified)

```bash
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=... NOVA_MEDIA_FS_ROOT=... \
  scripts/backup.sh <dest-dir>
# verify (hash-only without the key; +MAC +decrypt with it):
NOVA_BACKUP_KEY=... pnpm --filter @nova/api backup:verify -- \
  --dir=<dest-dir> --stamp=<stamp>
```
Artifacts are AES-256-GCM sealed (`*.enc`) with `NOVA_BACKUP_KEY` — a
SEPARATE key from the data key, never written into the backup — plus a
`manifest-<stamp>.json`. `umask 077`: dir `700`, files `600`. There is NO
plaintext-backup path: without the key the script fails. s3 media: rely on
bucket versioning + SSE.

**M15B (Hermes D02) — no plaintext survives a failure:** plaintext dump/tar
are written ONLY into a private `0700` `mktemp` workspace, sealed from there,
and only the `.enc` + manifest are moved into `<dest-dir>` after sealing
succeeds. A `trap … EXIT INT TERM` wipes the workspace on every exit path, so
an interrupted or failed run (e.g. a bad key) leaves the final dir
plaintext-free. **M15C (Hermes M15B-R02):** the underlying `backup:seal` step
now *requires* a separate plaintext `--work` and sealed `--out` dir and
rejects the old in-place `--dir` alias / `--work===--out` — plaintext and
sealed artifacts can never share a directory. `backup.sh` already passes
separate dirs; do not invoke `backup:seal` directly with one dir.

> **OPERATOR RULE:** run operator backups ONLY via `scripts/backup.sh` —
> **never invoke `backup:seal` directly.** **M16 hardened** the accepted M15
> P2 residual: `backup:seal` now compares the **physical** `--work`/`--out`
> directories via `realpath()` (symlinks resolved), so a symlinked `--out`
> aliasing `--work` is rejected — not just the lexical `path.resolve` case.
> `backup.sh` remains the only documented path (private `mktemp` `--work` +
> separate `--out`).

**M15B (Hermes D04) — the manifest is authenticated, not just hashed:** it
carries an HMAC-SHA256 `mac` (keyed with `NOVA_BACKUP_KEY`) over a canonical
body, plus per-artifact size + sha256 and a required `postgres` artifact.
`backup:verify` checks the MAC (catches a tampered size/timestamp/role or a
dropped artifact) before the per-artifact hash + decrypt. No secrets or key
material are stored in the manifest.

## Restore (M15/M15B: guarded)

```bash
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=... NOVA_MEDIA_FS_ROOT=... \
  NOVA_ENCRYPTION_KEY=<data-key> scripts/restore.sh <backup-dir> <stamp>
```
Destructive (`pg_restore --clean`). Guardrails: typed `RESTORE` confirm
(or `NOVA_RESTORE_CONFIRM=RESTORE`); `backup:verify` (manifest MAC + hash +
decrypt) BEFORE touching the DB; unseal → restore → `db:migrate` no-op +
`media:verify` + smoke reminder. Without the DATA key: metadata restores;
media/tokens stay ciphertext. Redis not restored (retryable work only):
re-approve in-flight actions; enrichment re-runs append versions.

**M15B (Hermes D03) — target guard by host + DSN redaction:** the
`DATABASE_URL` is NEVER printed; the script shows only a credential-redacted
`scheme://***@host:port/db`. A target counts as local scratch ONLY when the
host is loopback (`localhost`/`127.0.0.1`/`::1`) AND `NODE_ENV!=production` —
the database *name* is irrelevant, so a **remote** db named `nova_alpha` is
NOT local and requires `NOVA_RESTORE_ALLOW_PRODUCTION=yes`. Any non-local
target is refused without that override.

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
