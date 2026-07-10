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
| Worker (`services/worker/.env.example`) | `DATABASE_URL`, `REDIS_URL` | `NOVA_ENCRYPTION_KEY` (same as API — required for Notion execution), `ANTHROPIC_API_KEY` + `NOVA_CLOUD_ENRICHMENT` (cloud enrichment), `OPENAI_API_KEY` (embeddings), `NOVA_ENRICH_MODEL`, `NOVA_ANALYTICS` |
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
