# Nova Context — Session Handoff

> Working notes to resume without losing the thread. Not a design doc — the
> real design lives in `docs/`. This file tracks *where we are* and *what's next*.
> **Last updated: end of M4 (private-alpha hardening).**

## Where we are

**Milestones M0 → M4 are complete, committed, pushed, and CI-green** on branch
`claude/nova-context-foundation-5ze9zu` (open **draft PR #1**).

| Milestone | What shipped | Commit |
|---|---|---|
| Docs | 20 foundation docs (`README.md` + `docs/*`) | `3945804`, `6c77a6a`, … |
| M0 | Walking skeleton: extension capture → API → Postgres → web timeline | `e0d8079` |
| M1 | Voice (push-to-talk + Whisper), intent parsing, project suggestion, Nova tasks | `039e76d` |
| M2 | Async enrichment worker (BullMQ), hybrid search (FTS+pgvector), project pages, action approval queue, adapter interface | `04bb42e` |
| M3 | Live Context Mode v0 (ring buffer, grounded Q&A, save-from-live), capture-time redaction, export/delete | `784a0ab` |
| M4 | Onboarding+consent, user-visible audit log, security/prompt-injection suite, visual-redaction safeguards, export/delete hardening, Fly deploy configs, funnel analytics | `cd809bc` |

**PR:** https://github.com/celestinojbm/nova-context/pull/1 (draft, watched, CI green).

## Repo shape (pnpm + Turborepo monorepo)

```
packages/
  schema/          Zod contracts (single source of truth) + generated types
  model-router/    provider-agnostic: intent, transcription, embeddings, enrichment, live Q&A (all with fallbacks)
  context-engine/  shared logic: project suggestion, local enrichment, redaction, live ring buffer, consent, capture-mode
  config/          shared tsconfig base
services/
  api/             Fastify /v1 — routes split routes-m1..m4.ts; migrations/*.sql; adapters/ (nova-task=executes, notion=prepared+gated)
  worker/          BullMQ enrichment consumer
apps/
  extension/       WXT MV3 side panel (React) — capture, voice, live mode, onboarding, settings
  web/             Next.js — timeline+search, tasks, projects, approvals, audit, settings
infra/
  docker-compose.dev.yml   Postgres16+pgvector, Redis
  deploy/                  Dockerfiles + fly.{api,worker,web}.toml
  DEPLOY.md                private-alpha deploy guide
```

## How to run locally (verified working)

```bash
pnpm install
pnpm db:up                         # Postgres+pgvector + Redis via Docker
pnpm db:migrate                    # forward-only; seeds single dev user dev@nova.local
pnpm --filter @nova/api dev        # :3001  (set ANTHROPIC_API_KEY for live Q&A)
pnpm --filter @nova/worker dev     # enrichment worker
pnpm --filter @nova/web dev        # :3000
pnpm --filter @nova/extension build  # load .output/chrome-mv3 unpacked in chrome://extensions
```

Tests:
- `pnpm test` — unit (~90)
- `DATABASE_URL=postgres://nova:nova@localhost:5432/nova REDIS_URL=redis://localhost:6379 pnpm test:integration` — 66 integration (M0–M4 + worker + security suite)
- CI (`.github/workflows/ci.yml`) provisions Postgres+Redis and runs build → typecheck → unit → migrate → integration.

Note: the Docker daemon in this environment sometimes needs `sudo dockerd &` before `pnpm db:up`.

## Key architecture decisions already made (don't relitigate)

- **Single dev user + optional shared bearer token** — real auth (OAuth 2.1 + PKCE) is NOT built yet. Schema is ready for it. This is the M5 headline.
- **Every cloud call is opt-in and config-gated**: `NOVA_LIVE_QA`, `NOVA_CLOUD_ENRICHMENT`, `NOVA_REDACTION`, `NOVA_ANALYTICS`, provider keys. All in each service's `.env.example`.
- **Capture path is LLM-free/fast**; LLM enrichment is async in the worker.
- **Captured content is data, never instructions** — structurally enforced + security-tested.
- **Redaction is text-only** (emails, phones, Luhn cards, API keys, SSNs, IBANs). Pixels in screenshots/frames are NOT redacted — mitigated by warning + blur/text-only capture modes. True visual redaction is deferred.
- **Notion adapter is prepared and gated but NOT connected** — interface/preview/approval/audit done; OAuth connect flow deliberately deferred (`services/api/src/adapters/notion.ts`).
- **Live sessions are client-side only** — ring buffer in the extension, destroyed on stop; server is stateless for Q&A.
- **DB migrations are forward-only**, tracked in `schema_migrations`. Latest: `0004_m4_product_events.sql`.
- **API integration tests run file-serial** (`services/api/vitest.config.ts`) because they share one dev user.

## Recommended next work — M5 (in priority order)

1. **Real authentication** — OAuth 2.1 + PKCE, per-user scoping, replace the single dev user. Everything downstream (multi-user, sharing, enterprise) is blocked on this. **This is the natural M5 headline.**
2. **Notion OAuth connect flow** — activate the already-prepared `NotionAdapter`: encrypted token storage in `integration_connections` (column `token_ciphertext` already exists), callback through the web app, preview→approve→execute→audit, disconnect/revoke.
3. **Visual redaction v1** — on-device OCR-box detection to mask sensitive regions in screenshots, closing the one privacy gap M4 could only warn about.

(These come from the end-of-M4 report. Confirm scope with the user before starting — M4 followed the "hardening, not features" framing; M5's shape depends on whether the user wants auth-first or integration-first.)

## Known weaknesses carried forward (from milestone reports)

- Search fusion weights (0.6 FTS / 0.4 vector) are asserted, not tuned; no golden relevance set.
- Enrichment re-runs overwrite summary/tags (idempotent for proposals/entities only); no interpretation versioning yet.
- Embeddings/cloud enrichment/live Q&A untested against *real* providers in this env (fakes exercise the plumbing).
- CSS blur is not cryptographic redaction (recoverable from a stored blurred image in principle).
- Approvals execute inline in the HTTP request — fine for `nova_task`, needs a job for slow external adapters.
- Security suite covers structural containment, not model-level jailbreaks of the enrichment/Q&A models themselves.

## Operational reminders for the next session

- Branch to keep using: `claude/nova-context-foundation-5ze9zu`. PR #1 is a **draft** and is **watched** (CI failures + review comments arrive as events).
- If PR #1 gets **merged**, per the task rules treat follow-up as fresh work: restart the branch from the latest default branch and open a new PR (do not stack on merged history).
- Commit message trailers in use:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the `Claude-Session:` line.
- Do NOT put the model identifier in commits/PRs/code — chat only.
