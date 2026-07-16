# Nova Context

**Human Context Infrastructure.** A universal context intelligence platform that captures, understands, preserves, connects, and transforms human digital context into intelligent action.

Nova Context is not a chatbot. It is not a note-taking app. It is not "another assistant." It is the layer underneath assistants — the substrate that captures what a human was seeing, what they meant by it, and what they wanted done about it, and makes that available to any assistant they choose.

---

## The problem: lost context

Every day, people see valuable information on screens — in videos, social feeds, chats, websites, meetings, documents. It appears fast, changes fast, and disappears fast. Almost none of it is captured, and what is captured loses everything that made it valuable:

- A **screenshot** preserves pixels but not meaning, not intent, not the connection to the project you were working on.
- A **bookmark** preserves a link that rots, to a page whose relevant part you can no longer find.
- A **note** requires you to stop what you're doing and transcribe — so mostly you don't.
- An **AI assistant** could help, but it can't see your screen, forgets between sessions, and its memory is locked inside one vendor's app.

The result: the exact moment when information matters most — the moment you *notice* it — is the moment our tools serve worst. Nova Context exists to fix that moment, and to preserve what it captures with structure: what you perceived, what it meant, why it mattered right then, and what it connects to.

The full argument is in [The Context Manifesto](docs/THE_CONTEXT_MANIFESTO.md).

## What Nova is — and is not

| Nova is | Nova is not |
|---|---|
| Human Context Infrastructure: a capture → memory → action substrate | A chatbot |
| An API/SDK platform any assistant can plug into | A note-taking app |
| A user-owned memory layer that outlives any single assistant | "Another assistant" competing on model quality |
| Explicit, invoked, visibly-indicated capture | Ambient surveillance or always-on recording |
| A subscription and platform-fee business | A data business — user context is never monetized |

## Who it serves

**Individuals.**

- One memory of their digital life that they own — searchable, exportable in full, deletable in full.
- Capture anything on screen in under two seconds, with a spoken instruction attached.
- Every capture tends toward something useful: a task, a project link, an answer later.

**Developers and assistant vendors.**

- Nova is infrastructure-first. Assistants — Dona, ChatGPT, Claude, Gemini, Copilot, Perplexity, Cursor, enterprise agents, and eventually wearables and robots — are *clients* of Nova via the Nova Developer Platform: API, SDKs, webhooks, plugins.
- Instead of every assistant building its own siloed capture-and-memory stack, they plug into a shared, user-controlled one, with scoped permissions and a common approval envelope.

**Enterprises.**

- Organizational context with governance: SSO/SCIM, audit logs, data residency, self-host/VPC deployment.
- A risk-tiered action model that keeps humans in the approval loop for anything consequential.

## The two modes

Nova has exactly two product modes. Everything else in the system exists to serve them.

**1. Instant Capture Mode.**

- The user invokes Nova: keyboard shortcut, floating button, browser toolbar.
- Nova captures the currently visible context — screen frame(s), the recent buffer, active app/page metadata.
- Nova listens to the user's spoken instruction (push-to-talk), stores and organizes the resulting **Context Moment**, links it to a project, and creates an action.
- Total interaction time: seconds.

**2. Live Context Mode.**

- The user invokes Nova during an ongoing activity: a video, a meeting, a workflow.
- Nova observes a bounded live session — explicitly started, visibly indicated, explicitly ended.
- It listens, answers questions in real time grounded in what's on screen, extracts insights, and saves relevant context as it evolves.

There is no third, covert mode. **No always-on recording, ever.** The short local Context Buffer (default 60 seconds) is opt-in, bounded, RAM/encrypted-temp only, never uploaded wholesale, and auto-purged. This is an ethical commitment and a platform-policy requirement, and it is non-negotiable. See [First Principles](docs/FIRST_PRINCIPLES.md) and [Security, Privacy & Governance](docs/SECURITY_PRIVACY_GOVERNANCE.md).

## Infrastructure-first

The Nova app is a **reference client**, not the product. The durable asset is the context/memory/action substrate that other assistants build on — the same way Stripe is the payments substrate behind thousands of checkout pages and Plaid is the financial-data substrate behind thousands of fintech apps. The app proves the platform; the platform is the company. The reasoning and its consequences are in [First Principles](docs/FIRST_PRINCIPLES.md) and [Product Vision](docs/PRODUCT_VISION.md).

## Principles at a glance

The load-bearing commitments, in one screen (full versions with reasoning and design consequences in [First Principles](docs/FIRST_PRINCIPLES.md)):

- **Context = perception + meaning + intent + connection + time.** Drop any one and you're back to screenshots.
- **Capture must be explicit.** User-invoked, visibly indicated, bounded. Never covert.
- **The user is the root authority over their context.** Export everything, delete everything, no data monetization — ever.
- **Local-first.** Perception and buffering happen on-device; cloud is for heavy reasoning and sync, with data minimization; projects can be pinned local-only.
- **Human approval is a first-class primitive.** Actions are risk-tiered: Tier 0 auto (internal, reversible), Tier 1 preview-then-confirm (external writes), Tier 2 explicit approval + audit (data leaving the system, purchases, messages to people).
- **Context that never becomes action or insight is cost.** Retrieval and action are the point, not accumulation.
- **Minimum context necessary.** Capture, retain, and share the least that serves the user's stated intent.
- **Infrastructure over app.** APIs are contracts; the reference client keeps the platform honest.

## How the pieces fit

```
        Invocation (shortcut / button / toolbar / share sheet)
                              │
   ┌──────────────────────────▼───────────────────────────┐
   │  CAPTURE CLIENTS (local-first)                       │
   │  browser extension · desktop (Tauri, later) ·        │
   │  Android (later) · iOS companion (later)             │
   │  Context Buffer · frames · DOM/UI semantics · voice  │
   └──────────────────────────┬───────────────────────────┘
                              │  minimized Context Moments only
   ┌──────────────────────────▼───────────────────────────┐
   │  CONTEXT ENGINE      perception → meaning            │
   ├──────────────────────────────────────────────────────┤
   │  MEMORY ENGINE       layered memory · graph ·        │
   │                      embeddings · forgetting         │
   ├──────────────────────────────────────────────────────┤
   │  INTELLIGENCE ENGINE model routing by task, cost,    │
   │                      latency, privacy tier           │
   ├──────────────────────────────────────────────────────┤
   │  ACTION ENGINE       risk-tiered actions,            │
   │                      human approval primitive        │
   └──────────────────────────┬───────────────────────────┘
                              │
   ┌──────────────────────────▼───────────────────────────┐
   │  NOVA DEVELOPER PLATFORM (API · SDKs · webhooks)     │
   │  clients: Nova app (reference) · assistants ·        │
   │  agents · integrations                               │
   └──────────────────────────────────────────────────────┘
```

Full detail in [System Architecture](docs/SYSTEM_ARCHITECTURE.md).

## Project status

**M15 — Alpha Blocker Remediation.** An external adversarial audit (Hermes) reviewed baseline `49b6525` and returned **NO-GO** for private alpha until its P1 findings were fixed. M15 fixes them; the response is [docs/AUDIT_RESPONSE_M15.md](docs/AUDIT_RESPONSE_M15.md). **P1 — visual media is now fail-safe**: a screenshot whose OCR redaction fails is never stored as readable media (the media pipeline persists only `applied`/`none` states), production forces strict redaction regardless of what the client sends, the schema and extension defaults are strict, and every read/export path (`GET /v1/media/:id`, legacy `/v1/export`, account export, and the adapter gate) refuses unsafe states through one shared rule. **P1 — backups are sealed**: `scripts/backup.sh` now AES-256-GCM-encrypts every artifact with a *separate* `NOVA_BACKUP_KEY` (never written into the backup), writes a sha256 manifest, enforces `umask 077`, and fails closed without the key; `backup:verify` checks integrity (and, with the key, decryptability); `restore.sh` gained a typed confirmation, a production-target refusal, and verify-before-touch. **P2 — the rate limiter fails *closed***: a Redis outage now falls back to an in-memory window instead of waving attempts through, and surfaces a degraded state on `/status` and preflight. **P3 — `/readyz` leaks nothing**: it returns booleans only, with internal error detail going to structured logs. All fixes ship with regression tests (visual-media fail-safe, sealed-backup crypto/manifest, rate-limit fallback, readyz sanitization) and the full M0–M14 regression stays green. **The alpha remains gated**: no real user data until the operator explicitly approves, and a Hermes delta audit is recommended first.

**M14 — Private Alpha Execution.** Not a feature milestone: M14 *executed* the M13 machinery end to end as a full production-mode dress rehearsal, since no cloud credentials exist in the build environment — and says so plainly rather than pretending a deploy happened. What actually ran ([docs/ALPHA_RUN.md](docs/ALPHA_RUN.md) is the execution record with verbatim evidence): `ops:preflight` green in production mode plus all three fail-closed proofs (open signup, missing key, redaction-off each refuse); a real API + worker booted from built `dist/` on a fresh migrated database with **real Tesseract OCR**; `ops:smoke` fully green (20 ✓, live Q&A honestly degraded with no key configured); `ops:maintenance` + `ops:report` on the clean stack; and a complete **backup → restore → verify** cycle — `scripts/backup.sh`, `scripts/restore.sh` into a scratch database, `media:verify` proving every blob decryptable with the key and **0 verified / 3 undecryptable / exit 2 without it** (the "what cannot be restored without keys" proof). The rehearsal caught and fixed two real defects: a **corrupt-image API crash** (tesseract.js rethrows libpng errors out of band, killing the process — the OCR engine now Jimp-decodes/re-encodes first, so hostile bytes fail closed; regression-pinned, and `jimp` moved to production dependencies where it belonged) and a smoke misread of enrichment success. Also shipped: `feedback_by_category` + privacy-incident escalation in `ops:report`, the blocker list + exact operator sequence for the real deploy, the first-user onboarding package (alpha guide + new **emergency stop** section), the 7-day operating loop with decision log, and the gate decision (proceed pending infrastructure + explicit operator approval; extension primary; browser-shell deferred; Notion and all cloud features start disabled). **Hard gate: no real user data until the operator explicitly approves the alpha start.**

**M13 — Private Alpha Deployment + Real-World Usage Loop.** Nova Context is now deployable and operable as a controlled private alpha: **preflight** (`ops:preflight` — validates every boot rule plus live probes of Postgres/migrations/Redis/object-store/key material, and fails on production foot-guns like open signup or lingering rotation keys; production now also refuses to boot with redaction disabled unless explicitly acknowledged via `NOVA_ALLOW_UNSAFE_REDACTION=yes`), a **scripted post-deploy smoke suite** (`ops:smoke` — synthetic account walks readyz→signup→pairing→capture→redaction→media→timeline→search→live Q&A→save-from-live→tasks→approvals→Notion status→export→worker→delete→audit→status→heartbeat, then deletes itself through the real deletion flow; degraded ≠ failed, so intentionally-disabled features report honestly), **backup/restore completion** (`scripts/restore.sh` restores Postgres + fs media and runs the verification pair `db:migrate`-no-op + `media:verify`; keys stay in the secret store by design), an **alpha usage loop** (`ops:report` — allowlisted event counts, friction, failed actions with reasons, enrichment-by-provider as observed cloud spend, storage, feedback, warning thresholds; new `task_created`/`notion_action_executed`/`feedback_submitted` events; `/status` gains a features block and machine-checkable warnings), **bug intake** (Settings → "Report a problem" → `alpha_feedback` table; category allowlist, text-only — pasted data URLs rejected; audit/analytics record the category, never the message), **first-user onboarding** ([docs/ALPHA_GUIDE.md](docs/ALPHA_GUIDE.md) — install→pair→capture→live→Notion plus an honest "what Nova captures / never captures / known privacy limitations" section), **operator runbooks** ([docs/RUNBOOKS.md](docs/RUNBOOKS.md) — 14 command-oriented scenarios from deploy to "search didn't find it"), **reliability guardrails** (request timeout, media-storage warning threshold, `/readyz` as the deploy gate), and a **concrete pre-alpha security checklist** in `infra/DEPLOY.md` mapping every claim to its enforcing test or command. The browser shell stays an experimental M12 spike; the extension is the alpha surface.

**M12 — Nova Browser / Native Context Browser Discovery + Spike.** M12 answers a question rather than shipping a feature: *would a native browser surface beat the extension at capture, live context, and privacy?* The answer lives in [docs/NOVA_BROWSER.md](docs/NOVA_BROWSER.md) — strategy (Nova Browser is one **client** of the existing backend, never a fork of it), a five-way feasibility matrix (extension-only / Electron / CEF-Tauri-WebView / Chromium fork / platform partner), a full architecture proposal, a browser-specific threat model, and an extension-vs-shell decision table. The runnable evidence is `apps/browser-shell`: a **minimal Electron spike** (deliberately not a browser — no tabs, bookmarks, history, or sync) that opens a URL in a fully sandboxed page view, shows a Nova side panel, and on an **explicit click** captures title/URL/visible text/screenshot into a standard Context Moment via the existing API — same pairing auth as the extension, strict redaction on by default, server-side redaction/encryption/audit untouched, nothing captured ever stored locally or logged. Tests prove shell captures ride the existing rails (auth required, encrypted media, user isolation, log hygiene, page "instructions" stored as inert data). Verdict: **continue at spike scale** — the shell removes the extension's structural ceilings (occlusion-proof screenshots, persistent live context), but packaging (M14) waits for measured evidence. CI stays Electron-binary-free.

**M11 — Private Alpha Operations + Reliability Hardening.** Nova is now operable by one person for one trusted user: **deployment readiness** (`/readyz` gates on Postgres, migrations, Redis, and a live media-store probe; worker heartbeat via Redis; checklist, rollback notes, smoke tests, and a failure-mode→operator-action table in `infra/DEPLOY.md`), **backups and restore** (`scripts/backup.sh` for Postgres + media, keys deliberately excluded and documented, `media:verify` proves every blob exists and decrypts after a restore), **maintenance** (`ops:maintenance`, dry-run by default: orphan cleanup, delete-queue drain, dead sessions, expired pairing codes/OAuth states/reset tokens, failed-action visibility, opt-in event pruning — every run recorded and shown on the new authenticated **/status** page alongside queue depths and component health), **observability** (request-id correlation, structured worker logs with job/action ids, security event logs; a test pins that captured content, passwords, tokens, and keys never reach log output), **self-service password reset** (operator-delivered single-use token, no enumeration, revokes all sessions, rate-limited), **zero-downtime key rotation** (multi-key read via `NOVA_ENCRYPTION_KEYS_PREVIOUS` for media *and* tokens; rotate gradually, verify, drop the old key), a **single shared adapter media gate** (`@nova/context-engine/media-gate` — API and worker are thin wrappers, so the policy cannot drift), **Notion upload retry dedup** (persisted upload ids; no duplicate media on retries; gated live-provider smoke), **enrichment provenance on the timeline** (version/provider/model/history count), and a **search weight contract pinned by goldens** (intent > title > body). Details: [docs/AUTH.md](docs/AUTH.md) §Private alpha operations.

**M10 — Account Data Lifecycle + Notion Media Consent.** The data-ownership loop is closed: **full account export** (`GET /v1/export/account`, refs or inlined media — everything the account owns, integration tokens structurally excluded) and **full account deletion** (web session + password + typed `DELETE`; media blobs removed first with failures tombstoned for cleanup, token ciphertext overwritten, then one cascading transaction — what survives is a single counts-only tombstone and, transiently, encrypted-blob delete tombstones; the retention contract is a table in docs/AUTH.md). Deleting the account never silently deletes Nova-created pages inside Notion — connection revoked, local records gone, external content stays under the user's native control (documented policy). **Notion screenshots ship only through explicit consent**: the approval card lists each image with its redaction state, only visually-redacted media is tickable, nothing is included by default, execution re-verifies at send time and fails safely on any drift, every adapter access is audited, and upload uses Notion's File Upload API — never inline base64. **Enrichment is versioned**: every run appends an immutable provider/model-stamped version; the current pointer can be moved to any recorded version. Details: [docs/AUTH.md](docs/AUTH.md) §Account data lifecycle.

**M9 — Media Reliability + Storage Operations.** The media pipeline is now operable: **orphan cleanup** (`media:cleanup`, dry-run default, age-guarded, audited, structurally unable to delete referenced media), **hardened deletes** (a failed blob delete tombstones into `media_delete_queue` and is retried — user deletes never fail or silently leak because storage hiccuped), **per-user storage accounting** (`GET /v1/media/usage` + Settings UI: objects, encrypted/thumbnail bytes, by kind/redaction state/project, pending deletions — aggregates only), a **documented media-audit policy** (exports/deletes/adapter access always audited; direct views optional via `NOVA_MEDIA_VIEW_AUDIT`), and **key rotation v0** (`media:rotate-key`: old→new key re-encryption of every blob and integration token, dry-run, resumable, tested against wrong keys). Notion gains **database property mapping** — page vs database detection, per-user validated mapping of title/summary/source URL/tags/priority/captured-at/moment-ref onto real database properties, shown on the approval card and re-validated at execution — while screenshots stay out of Notion (adapter access is now interface-gated by redaction state; upload itself is an M10 consent decision). Search v2 adds a **prefix fallback** for partial queries, opt-in **ranking diagnostics**, and a wider golden suite proving masked values are unreachable even via prefix search. Details: [docs/AUTH.md](docs/AUTH.md) §Media operations.

**M8 — Media Pipeline v1.** Screenshots and live frames have moved **out of the moment payload** into a real media pipeline: after M7's OCR-box masking, each image (plus a ≤320px thumbnail) is **AES-256-GCM encrypted in the API process** and written to object storage — local filesystem by default, or any S3-compatible endpoint (AWS, MinIO, Cloudflare R2) via a three-method store abstraction — with `moment_media` as the source of truth. Access is **authenticated, user-scoped, and proxied** (`GET /v1/media/:id`, no public or signed URLs); deleting a moment or project deletes the blobs; export (`format_version` 2) inlines decrypted media so exports stay complete. Missing encryption key fails closed (images dropped, never stored unencrypted; production refuses to boot). Search now indexes the **non-masked OCR words** of each image, adds `has_media` / `image_redaction_state` filters, and is pinned by a golden fixture suite. Legacy inline media moves via a manual, idempotent backfill command that never stores unprovably-redacted pixels. Notion screenshot upload stays out (interface ready; M9 decides consent). Details: [docs/AUTH.md](docs/AUTH.md) §Media pipeline.

**M7 — Visual Redaction v1 + alpha hardening.** Screenshots and live frames are now **OCR-box masked before storage** (on-process Tesseract + the same detectors that redact text, plus one-time-code and address heuristics); each moment stores a values-free redaction report that also lands in the audit log. Fail-safes: strict mode drops images that can't be redacted, a server-side kill switch strips all screenshots, and live Q&A **drops** any frame it can't mask — unredacted pixels never reach a cloud model. Notion gains a per-user **destination selector** (shared pages/databases, saved default, approval-time override) and hardened page output (source metadata, moment + action audit references, privacy note; screenshots never uploaded). Auth: password change (revokes other sessions), sign-out-everywhere, operator reset command, Redis-backed rate limiting, and production boot checks. Details: [docs/AUTH.md](docs/AUTH.md).

**M6 — Notion, the first external integration.** Per-user Notion OAuth from web Settings (single-use user-bound state, token stored AES-256-GCM-encrypted, disconnect wipes the ciphertext), and job-based external action execution: approving a `notion_page` action enqueues it (`proposed → queued → executing → done|failed`) for the worker, which creates the page with the owner's decrypted token — idempotent on retry/redelivery (no duplicate pages), fully audited from connect to `external_id`, and the approval card shows the exact content that will be written before you approve. No connection → a clear "connect Notion first" state. `nova_task` stays inline. Details: [docs/AUTH.md](docs/AUTH.md) §Notion.

**M5 — real authentication & per-user isolation.** The hardcoded dev user and the M0 shared token are gone from runtime. Accounts are email + password (scrypt); sessions are opaque, revocable server-side tokens (hash-stored, fixed expiry). The web app keeps the token in an HttpOnly SameSite cookie and forwards it server-side; the extension pairs with a one-time 8-digit code and holds only its own revocable device token, re-prompting on expiry. A centralized fail-closed middleware protects every /v1 route (401 unauthenticated; cross-user access reads as 404), production signups are invite-only by default, and an isolation suite proves User A's moments, search, tasks, actions, audit, exports, and deletes are unreachable from User B. Details: [docs/AUTH.md](docs/AUTH.md).

**M4 — private-alpha hardening.** Not new features — trust. Onboarding + consent gate the extension (capture and live mode blocked until the user reads the disclosures and accepts; reviewable/resettable in Settings). A user-visible **audit log** in the web app shows every capture, live session, cloud call, action decision, deletion, and export — content-free by contract. A **security suite** proves captured page/live content is data, never instructions: it can't execute actions, self-approve, disable redaction, reassign projects, bypass cloud-call gates, tamper with audit, or exfiltrate stored memory. **Visual-redaction safeguards**: a standing warning that text redaction doesn't cover pixels, plus per-capture modes (full / blur / text-only). **Export/delete hardening**: export by project and date range, project deletion, confirmation on destructive deletes. **Privacy-preserving funnel analytics** (allowlisted event names, numeric/short props only, NOVA_ANALYTICS=off switch). And **deploy configs** for a boring three-app Fly.io private alpha (infra/DEPLOY.md).

Every cloud call is opt-in and config-gated: NOVA_LIVE_QA, NOVA_CLOUD_ENRICHMENT, NOVA_REDACTION, NOVA_ANALYTICS, provider keys — documented in each service's .env.example. Notion OAuth remains deferred (adapter prepared and gated).

### Getting started

```bash
pnpm install
pnpm db:up            # Postgres 16 + pgvector, Redis (Docker)
pnpm db:migrate       # applies schema (+ seed data on first run)
pnpm --filter @nova/api db:seed-dev   # give dev@nova.local a password (local only; see docs/AUTH.md)
pnpm --filter @nova/api dev      # API on :3001 (set REDIS_URL to enable enrichment)
pnpm --filter @nova/worker dev   # enrichment worker (reads services/worker/.env)
pnpm --filter @nova/web dev      # web app on :3000 — sign in (dev@nova.local / nova-dev-password) or sign up
pnpm --filter @nova/extension build   # then load apps/extension/.output/chrome-mv3 via chrome://extensions → Load unpacked
# Connect the extension: web app → Settings → Browser extension → Generate pairing code
```

Tests: `pnpm test` (unit) and `DATABASE_URL=postgres://nova:nova@localhost:5432/nova pnpm test:integration`. Configuration is documented in each workspace's `.env.example`.

Validation Gate (M17B): `pnpm validate:pr` orchestrates the full sequence (build → typecheck → test → migrate → integration) with go/no-go semantics and JSON/Markdown/JUnit reports under `artifacts/validation/`; CI runs it on every PR. Operator modes `validate:predeploy` / `validate:postdeploy` / `validate:recovery` honestly return `BLOCKED` until real infrastructure exists. See [docs/VALIDATION_GATE.md](docs/VALIDATION_GATE.md).

Where the MVP starts, in one paragraph: a **Chromium browser extension + local companion service + minimal cloud backend**, single user, English-first. Instant Capture in the browser (visible tab + DOM extract + push-to-talk instruction → Context Moment → project link → action, with Notion as the first integration), bounded Live Context on a tab (rolling 60s buffer, questions answered against it, "save this" promotion), and a Next.js web app for the memory timeline and action review. Everything else — mobile, wake word, marketplace, multi-model consensus, enterprise — is explicitly out until the core loop proves itself. Details and the full not-in-MVP list: [MVP Scope](docs/MVP_SCOPE.md).

## Documentation index

All documents live in [`docs/`](docs/). Each is self-contained but cross-linked.

### Vision & Strategy

| Document | What it covers |
|---|---|
| [The Context Manifesto](docs/THE_CONTEXT_MANIFESTO.md) | Why context is becoming a critical resource, why every existing tool class fails to preserve it, and the thesis that whoever holds context becomes infrastructure. |
| [Why Now](docs/WHY_NOW.md) | Why Nova was not realistically buildable in 2021 and is in 2026 — multimodal models, on-device AI, commodity embeddings, agent standards — plus what is *still* not possible. |
| [First Principles](docs/FIRST_PRINCIPLES.md) | The numbered principles the system is derived from: Context, Memory, Intent, Action, Human Approval, infrastructure-first — each with reasoning and design consequences. |
| [Theory of Human Digital Context](docs/THEORY_OF_HUMAN_DIGITAL_CONTEXT.md) | The conceptual model: what a Context Moment is, the anatomy of perception/meaning/intent/connection/time, and how context decays. |
| [Product Vision](docs/PRODUCT_VISION.md) | The product Nova becomes for individuals, developers, and enterprises; the two modes in depth; what Nova deliberately is not. |

### Architecture & Engineering

| Document | What it covers |
|---|---|
| [System Architecture](docs/SYSTEM_ARCHITECTURE.md) | End-to-end architecture: local-first capture clients, event-driven backend (ingestion → queue → workers → storage), Postgres + pgvector, and how the four engines compose. |
| [Context Engine](docs/CONTEXT_ENGINE.md) | Perception: screen understanding, OCR, UI semantics, app awareness, video/audio understanding, compression, ranking, retrieval, expiration. |
| [Context Buffer](docs/CONTEXT_BUFFER.md) | The short local rolling buffer — default 60s, max 5 min, local-only, auto-purged — and the rules for promoting buffer content into a Context Moment. |
| [Memory Engine](docs/MEMORY_ENGINE.md) | Layered memory (working, session, project, relationship, semantic, visual, long-term), knowledge graph + embeddings, versioning, forgetting, user control. |
| [Intelligence Engine](docs/INTELLIGENCE_ENGINE.md) | Model-agnostic orchestration: routing across providers by task type, cost, latency, and privacy tier; fallback chains; verification; benchmarking. |
| [Action Engine](docs/ACTION_ENGINE.md) | Turning context + intent into actions — tasks, documents, calendar events, GitHub issues, Notion pages, webhooks — under the risk-tiered approval model. |
| [API & SDK Spec](docs/API_AND_SDK_SPEC.md) | The Nova Developer Platform: REST + WebSocket/SSE surface, OAuth 2.1 + PKCE, permission scopes, TypeScript-first SDKs, webhooks, plugins. |

### Platform & Business

| Document | What it covers |
|---|---|
| [Security, Privacy & Governance](docs/SECURITY_PRIVACY_GOVERNANCE.md) | Threat model, encryption, consent architecture, audit logging, regulatory posture, and why "no data monetization" is enforced structurally, not just promised. |
| [Business Model](docs/BUSINESS_MODEL.md) | Free → Pro → Teams → Enterprise tiers; metered platform API; marketplace revenue share; OEM licensing; what Nova will never sell. |
| [Risks & Red Team](docs/RISKS_AND_RED_TEAM.md) | The honest failure modes: platform policy rejection, privacy backlash, OS-vendor competition, capture-quality ceilings — and mitigations or admissions for each. |

### Execution

| Document | What it covers |
|---|---|
| [Roadmap](docs/ROADMAP.md) | 30 days → 90 days → 6 months → 12 months → 3 years → 10 years, from browser-extension prototype to standards-level context infrastructure. |
| [MVP Scope](docs/MVP_SCOPE.md) | The locked MVP: Chromium extension + local companion service + minimal cloud backend, single user, English-first — including the explicit not-in-MVP list. |
| [Build Plan](docs/BUILD_PLAN.md) | The engineering sequence to ship the MVP: milestones, dependencies, stack decisions, and definition of done. |
| [Repo Structure](docs/REPO_STRUCTURE.md) | The monorepo layout (pnpm + Turborepo), package boundaries, and where each engine and client lives. |

## Suggested reading order

Different readers need different paths:

**If you have 20 minutes** (anyone): [The Context Manifesto](docs/THE_CONTEXT_MANIFESTO.md) → [First Principles](docs/FIRST_PRINCIPLES.md) → [MVP Scope](docs/MVP_SCOPE.md). Problem, commitments, and what we're actually building first.

**Founder / investor path**: Manifesto → [Why Now](docs/WHY_NOW.md) → [Product Vision](docs/PRODUCT_VISION.md) → [Business Model](docs/BUSINESS_MODEL.md) → [Roadmap](docs/ROADMAP.md) → [Risks & Red Team](docs/RISKS_AND_RED_TEAM.md). Read the risks doc last but do read it; it is the least flattering and the most useful.

**Engineer path**: [First Principles](docs/FIRST_PRINCIPLES.md) → [Theory of Human Digital Context](docs/THEORY_OF_HUMAN_DIGITAL_CONTEXT.md) → [System Architecture](docs/SYSTEM_ARCHITECTURE.md) → the four engine docs ([Context](docs/CONTEXT_ENGINE.md), [Memory](docs/MEMORY_ENGINE.md), [Intelligence](docs/INTELLIGENCE_ENGINE.md), [Action](docs/ACTION_ENGINE.md)) → [Context Buffer](docs/CONTEXT_BUFFER.md) → [MVP Scope](docs/MVP_SCOPE.md) → [Build Plan](docs/BUILD_PLAN.md) → [Repo Structure](docs/REPO_STRUCTURE.md).

**Developer / integration partner path**: [Product Vision](docs/PRODUCT_VISION.md) → [API & SDK Spec](docs/API_AND_SDK_SPEC.md) → [Security, Privacy & Governance](docs/SECURITY_PRIVACY_GOVERNANCE.md) → [Roadmap](docs/ROADMAP.md) (for platform GA timing).

**Skeptic path**: [Risks & Red Team](docs/RISKS_AND_RED_TEAM.md) → [Why Now](docs/WHY_NOW.md) (especially "what is still not possible") → [Security, Privacy & Governance](docs/SECURITY_PRIVACY_GOVERNANCE.md). If those three don't hold up, nothing else matters.

## Canonical vocabulary

Terms used consistently across every document:

- **Context Moment** — the atomic captured unit: screen frames + OCR text + UI semantics + audio/voice transcript + app/page metadata + timestamp + the user's intent utterance, stored as one structured record.
- **Context Buffer** — the short, local, opt-in rolling buffer that makes "capture what I just saw" possible without always-on recording.
- **Context Engine / Memory Engine / Intelligence Engine / Action Engine** — the four subsystems: perceive, preserve, reason, act.
- **Nova Developer Platform** — the public API, SDKs, webhooks, plugins, and marketplace through which assistants consume Nova.
- **Invocation** — any explicit user gesture that summons Nova: floating button, keyboard shortcut, browser toolbar, opt-in voice wake, hardware button mapping where the OS allows, share sheet on mobile.

## Contributing and contact

The code is at the M0 walking-skeleton stage and the documents remain the design source of truth. Substantive critique of the architecture, the platform-constraint analysis, or the risk register is as valuable as code right now — open an issue against the specific document and section. Vocabulary and scope changes must stay consistent across all documents; piecemeal edits that break cross-document consistency will be asked to widen their diff.
