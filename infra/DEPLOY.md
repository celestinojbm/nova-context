# Private alpha deployment

Boring by design: three Fly.io apps (API, worker, web), one managed Postgres
with pgvector, one managed Redis. Sized for a handful of trusted alpha users,
not for scale.

## Prerequisites

- Postgres 16 **with the pgvector extension** (Fly Postgres, Neon, or
  Supabase all work — `CREATE EXTENSION vector` must be permitted; the
  migration runs it).
- Redis (Fly Redis/Upstash). BullMQ needs a plain Redis connection string.
- `fly` CLI authenticated.

## Environment variables

The `.env.example` in each service is the documentation of record:

| Service | Required | Optional |
|---|---|---|
| API (`services/api/.env.example`) | `DATABASE_URL`, `NOVA_ENCRYPTION_KEY` (**required in production since M8** — media + integration encryption at rest) | `REDIS_URL` (enables enrichment), `NOVA_ALPHA_INVITE_CODE` (**production signups are invite-only by default**), `NOVA_SIGNUP` / session TTLs (see `docs/AUTH.md`), `NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET`/`NOTION_REDIRECT_URI` (M6 Notion), `OPENAI_API_KEY` (transcription + search embeddings), `ANTHROPIC_API_KEY` + `NOVA_LIVE_QA` (live answers), `NOVA_REDACTION` (default on), `NOVA_IMAGE_REDACTION`/`NOVA_SCREENSHOT_STORAGE`/`NOVA_OCR_*` (M7 visual redaction), `NOVA_RATE_LIMIT_MAX` (M7), `NOVA_MEDIA_STORE` fs\|s3 + `NOVA_MEDIA_FS_ROOT` or `NOVA_MEDIA_S3_*` (M8 media pipeline — prefer s3 in prod; fs needs a persistent volume), `NOVA_ANALYTICS` (default local), `NOVA_LIVE_MODEL` |
| Worker (`services/worker/.env.example`) | `DATABASE_URL`, `REDIS_URL` | `NOVA_ENCRYPTION_KEY` (same as API — required for Notion execution), `NOVA_MEDIA_STORE` + `NOVA_MEDIA_FS_ROOT`/`NOVA_MEDIA_S3_*` (M10 — same values as the API; needed only for actions approved WITH media), `ANTHROPIC_API_KEY` + `NOVA_CLOUD_ENRICHMENT` (cloud enrichment), `OPENAI_API_KEY` (embeddings), `NOVA_ENRICH_MODEL`, `NOVA_ANALYTICS` |
| Web | `NOVA_API_URL` | — (auth rides an HttpOnly session cookie set by the web app) |

## First deploy

```bash
# 1. Create the apps (once):
fly launch --no-deploy -c infra/deploy/fly.api.toml
fly launch --no-deploy -c infra/deploy/fly.worker.toml
fly launch --no-deploy -c infra/deploy/fly.web.toml

# 2. Set secrets per app, e.g.:
fly secrets set -c infra/deploy/fly.api.toml \
  DATABASE_URL=... REDIS_URL=... NOVA_ALPHA_INVITE_CODE=$(openssl rand -hex 12)

# 3. Deploy (API first — its release step runs migrations):
fly deploy -c infra/deploy/fly.api.toml
fly deploy -c infra/deploy/fly.worker.toml
fly deploy -c infra/deploy/fly.web.toml
```

Production builds locally: `pnpm exec turbo build` (or per-service
`--filter=@nova/api...` etc. — the Dockerfiles do exactly this).

## Migrations

Forward-only, tracked in `schema_migrations`, applied automatically by the
API's `release_command` (`node services/api/dist/db/migrate.js`) before each
release takes traffic. Manual run: `fly ssh console -c infra/deploy/fly.api.toml
-C "node services/api/dist/db/migrate.js"`.

## Rollback

- App rollback: `fly releases -c <config>` then `fly deploy -c <config>
  --image <previous image ref>`.
- Migrations are forward-only by policy: write a new migration to undo a
  bad one, never edit an applied file (the runner tracks by filename).
- M8 legacy media: rows captured before M8 may still hold inline
  screenshots. Move them with the manual operator command
  `pnpm --filter @nova/api media:backfill` (idempotent; skips anything it
  cannot prove was redacted — see `docs/AUTH.md`, "Legacy backfill").

## Media operations (M9)

- **Orphan cleanup / failed-delete retry**: `pnpm --filter @nova/api
  media:cleanup` (dry run) then `-- --delete`. Run occasionally, or after
  storage incidents; it retries tombstoned deletes (media_delete_queue)
  and removes blobs no `moment_media` row references. `--min-age-minutes`
  (default 60) protects in-flight captures.
- **Key rotation**: `NOVA_ENCRYPTION_KEY=<new> NOVA_ENCRYPTION_KEY_OLD=<current>
  pnpm --filter @nova/api media:rotate-key -- --apply`, verify
  `undecryptable: 0`, then redeploy API + worker with the new key. Offline
  rotation — do it in a maintenance window (see `docs/AUTH.md` §Media
  operations for the exact order and limitations).
- **Storage visibility**: per-user usage on the web Settings page (or
  `GET /v1/media/usage`); `pending_deletions` > 0 means the delete queue
  needs a `media:cleanup -- --delete` run.
- The worker and web can roll back independently of the API; the API's
  contracts are additive within a milestone.

## Health checks & logging

- API: `GET /healthz` (checks Postgres connectivity) — wired into
  `fly.api.toml`.
- Web: `GET /settings` (static-ish page proves the app serves).
- Worker: no HTTP by design; Fly restarts it if the process exits, and it
  logs a line per enrichment. Check queue depth in Redis if in doubt.
- Logs: everything is structured (pino) on stdout — `fly logs -c <config>`.
  API logs never contain captured payloads (contract; see the audit design).

## Extension for alpha users

Build with the deployed API URL in mind: `pnpm --filter @nova/extension zip`
produces a loadable zip; users load it unpacked (chrome://extensions →
Developer mode) and set the API URL + token in the side panel settings.
Web Store distribution is deliberately out of scope for the private alpha.

## Production deployment checklist (M11)

One trusted user, boring infrastructure. In order:

1. **Env validation** — every service validates env at boot and refuses to
   start on bad config. Pre-check locally: `NODE_ENV=production
   NOVA_ENCRYPTION_KEY=... node -e "require('./services/api/dist/env.js')"`
   or simply let the release fail fast. Production REQUIRES
   `NOVA_ENCRYPTION_KEY`; Notion requires the three `NOTION_*` vars and
   https redirect; s3 media requires bucket + credentials.
2. **Migrations** — applied automatically by the API release_command.
   `/readyz` reports `migrations: ok` only when nothing is pending.
3. **Health gates** — API: `GET /healthz` (liveness), `GET /readyz`
   (Postgres, migrations, Redis, media-store write/read/delete probe;
   503 until all pass). Point the deploy gate at `/readyz`.
4. **Worker readiness** — the worker writes a Redis heartbeat every 30s
   (90s TTL). Check `/v1/ops/status` (or the web `/status` page): worker
   `ok: true` with a fresh `last_beat`.
5. **Post-deploy smoke** (5 minutes):
   - sign in on the web app; check `/status` shows every component OK;
   - capture a moment from the extension (with a screenshot);
   - confirm the timeline shows the thumbnail; search finds the moment;
   - approve a `nova_task` action; if Notion is connected, approve a
     notion_page action WITHOUT media and confirm the page lands;
   - `pnpm --filter @nova/api media:verify` → everything verifies;
   - `pnpm --filter @nova/api ops:maintenance` (dry run) → sane counts.
6. **Rollback** — `fly releases` + redeploy previous image (see Rollback
   above). Migrations are forward-only: never roll the schema back; ship a
   correcting migration instead. Media blobs and tokens are unaffected by
   app rollbacks (same key, same format).

### One-user alpha assumptions

- One trusted user + the operator (often the same person). No tenant
  scaling concerns; every hot query is user-scoped and indexed.
- The operator delivers password-reset links out-of-band (no email).
- Maintenance runs manually (`ops:maintenance`); weekly is plenty.
  Wire a cron to the same command later if desired.
- Single API instance: the in-memory rate limiter fallback is acceptable
  when Redis is briefly down (Redis-backed when it's up).

### Failure modes → operator actions

| Symptom | Likely cause | Action |
|---|---|---|
| `/readyz` 503, postgres not ok | DB down/unreachable | restore DB service; API recovers on its own |
| `/readyz` 503, migrations pending | release step failed mid-way | run `db:migrate` manually; re-deploy |
| `/readyz` 503, media_store not ok | volume unmounted / bucket creds wrong | fix storage; captures meanwhile store WITHOUT media (state `media_unavailable`) — nothing is lost silently |
| worker `last_beat` stale on /status | worker crashed / Redis down | restart worker; queued jobs resume (BullMQ retries) |
| actions stuck `queued` | Redis or worker down | restore, jobs execute; approvals were never lost |
| `failed_actions` climbing on /status | see recent reasons in `ops:maintenance` output | terminal reasons (revoked token, unshared page) need the user to reconnect/re-share, then re-approve |
| `pending_media_deletes` > 0 | storage outage during deletes | `media:cleanup -- --delete` once storage is healthy |
| media 5xx on serve, `media:verify` reports undecryptable | wrong/missing key after rotation | restore the correct key or add the old one to `NOVA_ENCRYPTION_KEYS_PREVIOUS` |

## Backups & restore (M11)

`scripts/backup.sh <dest>` dumps Postgres (pg_dump custom format) and tars
the fs media root. What each piece means:

- **Postgres** — all metadata, moments, audit, encrypted tokens. Restore:
  `pg_restore --clean --dbname "$DATABASE_URL" nova-db-<stamp>.dump`.
- **Media objects** — encrypted blobs. fs: untar back to
  `NOVA_MEDIA_FS_ROOT`. s3: use bucket versioning/replication instead of
  tar.
- **Encryption key** — NOT in any backup, deliberately. Keep
  `NOVA_ENCRYPTION_KEY` (+ previous keys during rotation) in a secret
  store. **Without the key, a restore recovers metadata only**: media
  blobs and integration tokens are unreadable ciphertext (media can be
  re-captured; Notion can be reconnected — nothing unredacted ever
  becomes exposed, even to the restorer).
- **Redis** — not backed up. Queues carry retryable work only; after a
  restore, re-approve any in-flight external action; enrichment re-runs
  append versions (M10) so nothing is overwritten.
- **Verify a restore**: `pnpm --filter @nova/api db:migrate` (should
  no-op), then `pnpm --filter @nova/api media:verify` (every blob present
  AND decryptable → exit 0), then the post-deploy smoke above.

## Key rotation (updated for M11 multi-key read)

Zero-downtime procedure:

1. Generate the new key. Deploy API + worker with
   `NOVA_ENCRYPTION_KEY=<new>` and `NOVA_ENCRYPTION_KEYS_PREVIOUS=<old>`.
   Reads (media AND tokens) accept both; writes use the new key. No window.
2. Re-encrypt gradually: `NOVA_ENCRYPTION_KEY=<new>
   NOVA_ENCRYPTION_KEY_OLD=<old> pnpm --filter @nova/api media:rotate-key
   -- --apply` (resumable; re-run until `undecryptable: 0`).
3. `pnpm --filter @nova/api media:verify` with ONLY the new key configured
   → everything verifies → remove `NOVA_ENCRYPTION_KEYS_PREVIOUS` and
   redeploy. Old key can now be destroyed.

## Notion media smoke (real provider checklist)

The fake-provider path is covered in CI. Before first real use:

1. Create a test integration + workspace; share one page with it.
2. `NOVA_NOTION_SMOKE_TOKEN=<token> NOVA_NOTION_SMOKE_PARENT=<page-id>
   pnpm --filter @nova/worker exec vitest run
   test/integration/notion-live-smoke.test.ts` — uploads a 1×1 PNG via the
   File Upload API and creates a page with it attached; prints the page
   URL. Delete the page afterwards.
3. In the product: capture WITH a screenshot, approve a Notion action and
   tick the image, confirm the page carries it; approve another WITHOUT
   ticking and confirm no image lands. Check `media.adapter_access` in the
   audit log.
