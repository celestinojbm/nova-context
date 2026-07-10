# Nova Context — Session Handoff

> Working notes to resume without losing the thread. Not a design doc — the
> real design lives in `docs/`. This file tracks *where we are* and *what's next*.
> **Last updated: end of M13 (Private Alpha Deployment + Real-World Usage Loop).**

## Where we are

**Milestones M0 → M13 are complete.** M0–M12 are MERGED to `main` (PR #1:
docs+M0–M4; PR #2: M5+M6; PR #3: M7; PR #4: M8; PR #5: M9; PR #6: M10;
PR #7: M11; PR #8: M12). **M13 lives on branch `claude/m13-nova-context`.**

| Milestone | What shipped | Commit |
|---|---|---|
| Docs | 20 foundation docs (`README.md` + `docs/*`) | `3945804`, `6c77a6a`, … |
| M0 | Walking skeleton: extension capture → API → Postgres → web timeline | `e0d8079` |
| M1 | Voice (push-to-talk + Whisper), intent parsing, project suggestion, Nova tasks | `039e76d` |
| M2 | Async enrichment worker (BullMQ), hybrid search (FTS+pgvector), project pages, action approval queue, adapter interface | `04bb42e` |
| M3 | Live Context Mode v0 (ring buffer, grounded Q&A, save-from-live), capture-time redaction, export/delete | `784a0ab` |
| M4 | Onboarding+consent, user-visible audit log, security/prompt-injection suite, visual-redaction safeguards, export/delete hardening, Fly deploy configs, funnel analytics | `cd809bc` |
| M5 | Real auth (scrypt passwords + opaque revocable sessions), HttpOnly-cookie web sessions, extension pairing-code flow, fail-closed /v1 middleware, per-user isolation + suite, signup policy (invite-only prod), sessions UI | `1d15faf` |
| M6 | Notion OAuth per user (state-validated, AES-256-GCM tokens), job-based external action execution (proposed→queued→executing→done/failed, idempotent, retries), preview cards, connect/disconnect UI, audit chain incl. external ids | `79aa23e` |
| M7 | Visual Redaction v1 (Tesseract OCR-box masking before storage/live/export, strict mode, storage kill switch, values-free reports+audit), Notion destination selector + content hardening, auth hardening (password change, revoke-all, operator reset, Redis rate limit, prod checks) | `3847feb` |
| M8 | Media Pipeline v1: moment_media as source of truth, AES-256-GCM-encrypted blobs in object storage (fs default / any S3-compatible via abstraction, MinIO in compose), proxied user-scoped `/v1/media/:id` + thumbnails, delete/export lifecycle, manual legacy backfill, search over safe OCR text + media filters + golden fixtures, prod fail-closed on missing key | `07e4e5c` |
| M9 | Media Reliability + Storage Ops: orphan cleanup command (dry-run default, age guard, audited), tombstoned/retryable blob deletes (media_delete_queue), per-user storage accounting API + Settings UI, media audit policy (view audit opt-in), key rotation v0 command (media + tokens, resumable), Notion database property mapping (validated, previewed, re-validated at execution), adapter media-access guard, search prefix fallback + ranking diagnostics | `310f9a8` |
| M10 | Account Data Lifecycle + Notion Media Consent: full account export (refs/full media, tokens structurally excluded), full account delete (web+password+typed DELETE; blobs first, failures tombstoned, counts-only account_tombstones survives), documented external-deletion semantics, Notion screenshot upload behind explicit per-image consent (preview eligibility, approve media_ids, worker re-verify + File Upload API, adapter access audited), enrichment versioning (immutable versions + select-current) | `65d270a` |
| M11 | Private Alpha Ops: /readyz + worker heartbeat + authed /status page, ops:maintenance (dry-run default) + ops_maintenance_runs, backup.sh + media:verify, password reset (operator-delivered token, sessions revoked), multi-key read (NOVA_ENCRYPTION_KEYS_PREVIOUS → zero-downtime rotation), shared adapter media gate (@nova/context-engine/media-gate), Notion upload retry dedup + gated live smoke, request-id correlation + structured worker logs + log-hygiene test, enrichment provenance UI, search weight goldens | `29f80ef` |
| M12 | Nova Browser / Native Context Browser Discovery + Spike: `docs/NOVA_BROWSER.md` (strategy: one client of the platform, not a fork; feasibility matrix extension/Electron/CEF-Tauri/fork/partner; full architecture proposal; threat model; extension-vs-shell decision table; recommendation: continue at spike scale), minimal Electron shell `apps/browser-shell` (sandboxed page view + Nova side panel, pairing auth, explicit-click capture → existing moments API, strict redaction default ON, no local captured content), shell unit tests + API integration suite proving shell captures ride the existing redaction/media/isolation/log-hygiene rails | `782ae2a` |
| M13 | Private Alpha Deployment + Usage Loop: ops:preflight (boot rules + live DB/Redis/store/key probes, fails on open-signup/partial-Notion/pending-migrations; prod refuses redaction-off without NOVA_ALLOW_UNSAFE_REDACTION=yes), ops:smoke (scripted post-deploy walk of the whole surface via HTTP, synthetic content, self-deleting account, ok/degraded/fail), ops:report (usage/friction/feedback/warnings aggregates), scripts/restore.sh + verification, alpha_feedback intake (migration 0012, POST /v1/feedback, Settings form, category-only audit/analytics), events task_created/notion_action_executed/feedback_submitted, /status features+warnings blocks, request timeout + media warn threshold, /readyz as Fly deploy gate, docs/RUNBOOKS.md (14 runbooks), docs/ALPHA_GUIDE.md (onboarding + honest privacy limits), security checklist in DEPLOY.md | this branch |

## Repo shape (pnpm + Turborepo monorepo)

```
packages/
  schema/          Zod contracts (single source of truth) — now includes auth.ts
  model-router/    provider-agnostic: intent, transcription, embeddings, enrichment, live Q&A
  context-engine/  shared logic: project suggestion, redaction, live buffer, consent,
                   capture-mode, notion-page builder; secret-box via subpath export
  config/          shared tsconfig base
services/
  api/             Fastify /v1 — auth/ (passwords, sessions, plugin), routes-auth.ts,
                   routes-integrations.ts (M6 Notion OAuth + preview + M9 mapping),
                   routes-account.ts (M10 export/delete/enrichment versions),
                   routes-m1..m4.ts, routes-media.ts (M8 proxied media + M9 usage),
                   media/ (object-store.ts fs+s3+list, media-service.ts, cleanup.ts),
                   db/{backfill-media,cleanup-media,rotate-media-key}.ts (operator cmds);
                   migrations/*.sql (latest 0012_m13_alpha_feedback.sql)
  worker/          BullMQ consumers: enrichment (+ versioning) + action execution
                   (actions.ts, notion-client.ts incl. File Upload API,
                   media-reader.ts guarded adapter reads) — idempotent
apps/
  extension/       WXT MV3 side panel — Connect (pairing) screen, capture, voice, live mode
  web/             Next.js — /login, middleware guard, cookie session, settings (pairing +
                   session revocation), /export proxy, timeline/tasks/projects/approvals/audit
  browser-shell/   M12 SPIKE — minimal Electron shell (sandboxed page view + Nova panel,
                   pairing auth, explicit capture → existing API); see docs/NOVA_BROWSER.md
infra/
  docker-compose.dev.yml   Postgres16+pgvector, Redis, optional MinIO (profile media-s3)
  deploy/                  Dockerfiles + fly.{api,worker,web}.toml (NODE_ENV=production on API)
  DEPLOY.md                private-alpha deploy guide
```

## How to run locally (verified working)

```bash
pnpm install
pnpm db:up                         # Postgres+pgvector + Redis via Docker
pnpm db:migrate                    # forward-only; latest 0012_m13_alpha_feedback.sql
pnpm --filter @nova/api db:seed-dev  # gives dev@nova.local a password (local only)
pnpm --filter @nova/api dev        # :3001
pnpm --filter @nova/worker dev     # enrichment worker
pnpm --filter @nova/web dev        # :3000 — sign in dev@nova.local / nova-dev-password (or sign up)
pnpm --filter @nova/extension build  # load .output/chrome-mv3; connect via Settings → pairing code
```

Tests:
- `pnpm test` — unit (~138: schema, engines incl. visual redaction + notion mapping, env incl. M13 unsafe-setting refusal, auth helpers, M12 browser-shell capture/auth)
- `DATABASE_URL=postgres://nova:nova@localhost:5432/nova REDIS_URL=redis://localhost:6379 pnpm test:integration` — 190 API (+1 gated) + 30 worker (+1 gated live Notion smoke) (M0–M13; alpha-feedback, alpha-ops, smoke suites are M13)
- `pnpm --filter @nova/browser-shell test` — 14 shell units (payload shape vs shared schema, hostile-page sanitize, instruction-as-data, auth client); CI never downloads the Electron binary (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`)
- `NOVA_OCR_E2E=1 DATABASE_URL=... pnpm --filter @nova/api exec vitest run test/integration/ocr-e2e.test.ts` — real-Tesseract proof (downloads ~2MB language data once)
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
- **Visual redaction is REAL (M7, docs/AUTH.md §Visual Redaction)**: OCR-box
  masking (on-process tesseract.js + jimp via `@nova/context-engine/visual-redaction`
  subpath) runs in the capture path and on live-Q&A frames. Fail-safes:
  strict mode drops unredactable images; live frames that can't be masked
  are always dropped; `NOVA_SCREENSHOT_STORAGE=off` strips everything.
  OCR-miss limits (stylized/tiny/rotated text, faces, QR codes) are
  documented; blur/text-only modes remain for high-risk screens. CI uses
  fake OCR engines; the real-Tesseract path is proven by a gated e2e
  (`NOVA_OCR_E2E=1`) — run it locally when touching this area.
- **Notion is LIVE (M6, docs/AUTH.md §Notion)**: per-user OAuth (web-only,
  single-use user-bound state), tokens AES-256-GCM at rest
  (`@nova/context-engine/secret-box`, NOVA_ENCRYPTION_KEY, fail-closed),
  approve→queue→worker execution with jobId=actionId idempotency and
  stored-external-id short-circuit. secret-box is a SUBPATH export
  (`@nova/context-engine/secret-box`) so the browser extension bundle never
  pulls node:crypto.
- **Media pipeline is REAL (M8, docs/AUTH.md §Media pipeline)**: pixels
  live in `moment_media` + object storage, NEVER in payload JSONB. Order
  is sacred: capture → text redaction → visual redaction → encrypt+store →
  DB reference → everything else. Blobs are AES-256-GCM sealed in the API
  process (`NOVA_ENCRYPTION_KEY`, same secret-box as tokens; version byte
  = rotation hook); the store never sees plaintext. `ObjectStore` is a
  3-method interface — `FsObjectStore` (default) / `S3ObjectStore`
  (AWS/MinIO/R2). Access is proxied `GET /v1/media/:id` (auth + user
  scope + decrypt per request; NO signed/public URLs). Missing key fails
  closed: images dropped (`media_unavailable`), prod refuses to boot.
  Safe OCR words land in `context_moments.ocr_text` (tsv weight C);
  masked words never reach the index. Legacy inline media moves ONLY via
  the manual `media:backfill` command (skips what it can't prove redacted).
- **Media ops are REAL (M9, docs/AUTH.md §Media operations)**: failed blob
  deletes tombstone into `media_delete_queue` (never silent, never fail
  the user's delete); `media:cleanup` retries them + removes orphans
  (dry-run default, min-age guard, global valid-set so referenced media
  can't be deleted); `media:rotate-key` re-encrypts blobs + tokens old→new
  (resumable, offline — redeploy with the new key after). Audit policy:
  exports/deletes/adapter access ALWAYS; views opt-in
  (NOVA_MEDIA_VIEW_AUDIT). Adapters may read media ONLY through
  `MediaService.getForAdapter` (refuses non-'applied' redaction without
  explicit override).
- **Notion database mapping (M9)**: per-user mapping stored in the user's
  connection meta (`destination_mapping`), validated against the live DB
  schema at save AND execution (drift → field dropped, not action failed);
  shared validator/builder in `@nova/context-engine` notion-mapping.
- **Account lifecycle is REAL (M10, docs/AUTH.md §Account data lifecycle)**:
  `GET /v1/export/account` (refs|full media; token_ciphertext never
  selected) and `POST /v1/auth/account/delete` (web session + password +
  typed DELETE; blobs first with queue tombstoning, token wipe, then one
  cascading transaction). Retention after deletion = ONE counts-only
  `account_tombstones` row + transient `media_delete_queue` keys. External
  content is NEVER silently deleted (Notion pages stay; connection +
  local records go) — documented policy, no optional external cleanup.
- **Notion media consent (M10)**: screenshots reach Notion ONLY via
  per-image checkboxes on the approval card (eligible = redaction_state
  'applied'), validated at approve (owner + moment + redacted), re-verified
  at execution (drift → terminal `approved_media_*` failure, page NOT
  created), audited per access (`media.adapter_access`), uploaded via
  Notion's File Upload API (never inline base64). Object store is shared
  code now: `@nova/context-engine/object-store` (api re-exports; worker
  reads via `media-reader.ts`).
- **Enrichment versioning (M10)**: every run appends `enrichment_versions`
  (provider/model/created_at); moment columns are the current pointer;
  list/select endpoints move it without losing history.
- **Live sessions are client-side only**; server stateless for Q&A.
- **DB migrations are forward-only**; latest `0012_m13_alpha_feedback.sql`.
- **API integration tests run file-serial** (`services/api/vitest.config.ts`); regression suites log in as the dev user, auth/isolation suites create fresh accounts.

## Recommended next work — M14+ (see docs/NOVA_BROWSER.md §7 for the browser track)

**M13 — Private Alpha Deployment + Usage Loop** is DONE (this branch). The
deploy path is fully scripted-or-checklisted (preflight → deploy → smoke →
report loop, runbooks, restore, security checklist, onboarding guide);
what it deliberately does NOT do is a real cloud deploy — no credentials
exist in this environment, so the deliverable is deploy-ready configs +
exact operator instructions (DEPLOY.md), not a pretend deployment.

1. **M14 — actually run the alpha.** Provision Fly/Neon/Upstash (or
   equivalents), run `ops:preflight`, deploy, `ops:smoke`, onboard the
   trusted user with docs/ALPHA_GUIDE.md, then live the weekly loop
   (`ops:report` + `ops:maintenance` + feedback triage runbook) for a few
   weeks. The report's friction section decides what to build next —
   likely candidates: fixes reality finds, real Notion live smoke, email
   delivery, cron'd maintenance.
2. **Browser track (unchanged gates, docs/NOVA_BROWSER.md §7)** — desktop
   packaging only IF the spike proves value with a real user; browser-
   native live context only after that.
3. **Still-standing ops items** — real Notion live smoke against a real
   workspace; email delivery (replaces operator reset links); multi-part
   Notion media uploads; cron ops:maintenance once cadence is proven.

## Known weaknesses carried forward

- Duplicate-page window exists if the worker dies between the Notion create
  call and the one-statement DB completion (Notion has no idempotency keys).
- No real cloud deploy has run yet (no credentials in the build env):
  DEPLOY.md/preflight/smoke are exercised locally + in CI, not against Fly.
- M13 usage counters are approximations (product events + enrichment
  versions), not provider billing data; cost thresholds are warnings only.
- Browser shell is a SPIKE: single view, no tabs/packaging/auto-update,
  device token in a 0600 file (keychain later), `blurred` mode and live
  context not implemented, GUI comparison experiment not yet run
  (protocol in docs/NOVA_BROWSER.md §4).
- Search fusion weights (0.6 FTS / 0.4 vector) untuned; prefix fallback is
  not typo tolerance. Golden fixtures pin expected retrieval
  (`test/integration/search-golden.test.ts`).
- Media cleanup + maintenance are manual operator commands (deliberate for
  alpha); key rotation is now zero-downtime via multi-key read.
- Notion File Upload path is fake-tested; the gated live smoke + checklist
  exist but need real credentials to run; single-part uploads only.
- `ObjectStore.list()` loads the full key list into memory — fine at alpha
  scale, revisit before millions of objects.
- Fs media store has no replication — production should use the s3 backend.
- CSS blur is not cryptographic redaction.
- Security suite covers structural containment, not model-level jailbreaks.

## Operational reminders for the next session

- M13 branch: `claude/m13-nova-context` (based on merged main with M0–M12).
- If the M13 PR gets **merged**, treat follow-up as fresh work: restart from
  the latest main and open a new PR.
- Commit message trailers in use:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the `Claude-Session:` line.
- Do NOT put the model identifier in commits/PRs/code — chat only.
