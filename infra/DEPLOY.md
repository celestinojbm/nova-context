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
| API (`services/api/.env.example`) | `DATABASE_URL` | `REDIS_URL` (enables enrichment), `NOVA_API_TOKEN` (**set it in alpha** — it's the only auth), `OPENAI_API_KEY` (transcription + search embeddings), `ANTHROPIC_API_KEY` + `NOVA_LIVE_QA` (live answers), `NOVA_REDACTION` (default on), `NOVA_ANALYTICS` (default local), `NOVA_LIVE_MODEL` |
| Worker (`services/worker/.env.example`) | `DATABASE_URL`, `REDIS_URL` | `ANTHROPIC_API_KEY` + `NOVA_CLOUD_ENRICHMENT` (cloud enrichment), `OPENAI_API_KEY` (embeddings), `NOVA_ENRICH_MODEL`, `NOVA_ANALYTICS` |
| Web | `NOVA_API_URL` | `NOVA_API_TOKEN` (must match the API's) |

## First deploy

```bash
# 1. Create the apps (once):
fly launch --no-deploy -c infra/deploy/fly.api.toml
fly launch --no-deploy -c infra/deploy/fly.worker.toml
fly launch --no-deploy -c infra/deploy/fly.web.toml

# 2. Set secrets per app, e.g.:
fly secrets set -c infra/deploy/fly.api.toml \
  DATABASE_URL=... REDIS_URL=... NOVA_API_TOKEN=$(openssl rand -hex 24)

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
