# Nova Context — Session Handoff

> Working notes to resume without losing the thread. Not a design doc — the
> real design lives in `docs/`. This file tracks *where we are* and *what's next*.
> **Last updated: end of M5 (real auth + per-user isolation).**

## Where we are

**Milestones M0 → M5 are complete.** M0–M4 shipped on branch
`claude/nova-context-foundation-5ze9zu` (draft PR #1); **M5 lives on branch
`claude/m5-auth-user-isolation-oh9td0`**.

| Milestone | What shipped | Commit |
|---|---|---|
| Docs | 20 foundation docs (`README.md` + `docs/*`) | `3945804`, `6c77a6a`, … |
| M0 | Walking skeleton: extension capture → API → Postgres → web timeline | `e0d8079` |
| M1 | Voice (push-to-talk + Whisper), intent parsing, project suggestion, Nova tasks | `039e76d` |
| M2 | Async enrichment worker (BullMQ), hybrid search (FTS+pgvector), project pages, action approval queue, adapter interface | `04bb42e` |
| M3 | Live Context Mode v0 (ring buffer, grounded Q&A, save-from-live), capture-time redaction, export/delete | `784a0ab` |
| M4 | Onboarding+consent, user-visible audit log, security/prompt-injection suite, visual-redaction safeguards, export/delete hardening, Fly deploy configs, funnel analytics | `cd809bc` |
| M5 | Real auth (scrypt passwords + opaque revocable sessions), HttpOnly-cookie web sessions, extension pairing-code flow, fail-closed /v1 middleware, per-user isolation + suite, signup policy (invite-only prod), sessions UI | this branch |

## Repo shape (pnpm + Turborepo monorepo)

```
packages/
  schema/          Zod contracts (single source of truth) — now includes auth.ts
  model-router/    provider-agnostic: intent, transcription, embeddings, enrichment, live Q&A
  context-engine/  shared logic: project suggestion, redaction, live buffer, consent, capture-mode
  config/          shared tsconfig base
services/
  api/             Fastify /v1 — auth/ (passwords, sessions, plugin), routes-auth.ts,
                   routes-m1..m4.ts; migrations/*.sql (latest 0005_m5_auth.sql)
  worker/          BullMQ enrichment consumer (no HTTP; DB-scoped by user_id)
apps/
  extension/       WXT MV3 side panel — Connect (pairing) screen, capture, voice, live mode
  web/             Next.js — /login, middleware guard, cookie session, settings (pairing +
                   session revocation), /export proxy, timeline/tasks/projects/approvals/audit
infra/
  docker-compose.dev.yml   Postgres16+pgvector, Redis
  deploy/                  Dockerfiles + fly.{api,worker,web}.toml (NODE_ENV=production on API)
  DEPLOY.md                private-alpha deploy guide
```

## How to run locally (verified working)

```bash
pnpm install
pnpm db:up                         # Postgres+pgvector + Redis via Docker
pnpm db:migrate                    # forward-only; latest 0005_m5_auth.sql
pnpm --filter @nova/api db:seed-dev  # gives dev@nova.local a password (local only)
pnpm --filter @nova/api dev        # :3001
pnpm --filter @nova/worker dev     # enrichment worker
pnpm --filter @nova/web dev        # :3000 — sign in dev@nova.local / nova-dev-password (or sign up)
pnpm --filter @nova/extension build  # load .output/chrome-mv3; connect via Settings → pairing code
```

Tests:
- `pnpm test` — unit (~100: schema, engines, env, auth helpers)
- `DATABASE_URL=postgres://nova:nova@localhost:5432/nova REDIS_URL=redis://localhost:6379 pnpm test:integration` — 82 API + 7 worker (M0–M5 + security + auth + isolation)
- CI (`.github/workflows/ci.yml`) provisions Postgres+Redis and runs build → typecheck → unit → migrate → integration.

Note: the Docker daemon in this environment sometimes needs `sudo dockerd &` before `pnpm db:up`.

## Key architecture decisions already made (don't relitigate)

- **Auth (M5, see docs/AUTH.md)**: email+password (Node scrypt) + opaque
  server-side sessions (SHA-256-stored, fixed TTL, revocable). API is
  Bearer-only (no cookies read server-side ⇒ no CSRF surface); the web app
  owns an HttpOnly SameSite=Lax cookie and forwards the token server-side;
  the extension pairs via one-time 8-digit codes and stores only its device
  token. OAuth 2.1/PKCE deliberately deferred until third-party clients
  exist. `NOVA_API_TOKEN` is REMOVED everywhere.
- **Fail closed**: every /v1 route requires a session except the signup/
  login/pairing-claim allowlist (rate-limited). Cross-user access → 404.
- **Signup policy**: dev = open; production defaults to invite-only
  (`NOVA_ALPHA_INVITE_CODE`); without a code, prod signup fails closed.
- **Dev user**: `dev@nova.local` remains only as seed data. It has no
  password until `db:seed-dev` runs (which refuses under NODE_ENV=production).
  All pre-M5 local data stays under it — sign in as it to keep that data.
- **Every cloud call is opt-in and config-gated**: `NOVA_LIVE_QA`, `NOVA_CLOUD_ENRICHMENT`, `NOVA_REDACTION`, `NOVA_ANALYTICS`, provider keys.
- **Capture path is LLM-free/fast**; LLM enrichment is async in the worker.
- **Captured content is data, never instructions** — structurally enforced + security-tested.
- **Redaction is text-only**; pixels are mitigated by warning + blur/text-only modes.
- **Notion adapter prepared and gated but NOT connected** — M5 added OAuth design notes (docs/AUTH.md §Notion) but no implementation, per scope.
- **Live sessions are client-side only**; server stateless for Q&A.
- **DB migrations are forward-only**; latest `0005_m5_auth.sql`.
- **API integration tests run file-serial** (`services/api/vitest.config.ts`); regression suites log in as the dev user, auth/isolation suites create fresh accounts.

## Recommended next work — M6 (in priority order)

1. **Notion OAuth connect flow** — activate the prepared `NotionAdapter`
   following docs/AUTH.md's design notes: callback on the web app, encrypted
   token in `integration_connections.token_ciphertext`, per-user connection
   loading, preview→approve→execute→audit, disconnect/revoke. Move approval
   execution into a worker job first (currently inline in the HTTP request).
2. **Visual redaction v1** — on-device OCR-box masking for screenshots.
3. **Auth hardening follow-ups** (smaller): password reset story, optional
   passkeys, Redis-backed rate limiting if the API scales past one instance.

## Known weaknesses carried forward

- Login rate limiting is in-process (per-instance) — fine single-instance.
- No password reset flow (operator resets `password_hash` manually in alpha).
- Search fusion weights (0.6 FTS / 0.4 vector) still untuned; no golden set.
- Enrichment re-runs overwrite summary/tags; no interpretation versioning.
- Approvals execute inline in the HTTP request — needs a job before Notion.
- CSS blur is not cryptographic redaction.
- Security suite covers structural containment, not model-level jailbreaks.

## Operational reminders for the next session

- M5 branch: `claude/m5-auth-user-isolation-oh9td0` (draft PR, watched).
- If the M5 PR gets **merged**, treat follow-up as fresh work: restart the
  branch from the latest default branch and open a new PR.
- Commit message trailers in use:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the `Claude-Session:` line.
- Do NOT put the model identifier in commits/PRs/code — chat only.
