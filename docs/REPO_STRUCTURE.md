# Repository Structure

**Why this document:** code gets scaffolded next, and the cheapest time to decide where things live is before anything exists. This document specifies the monorepo layout, what belongs (and pointedly does *not* belong) in each directory, and the conventions — naming, commits, ADRs, versioning, CI — that keep a multi-app, multi-service TypeScript codebase coherent. It implements the stack decisions in [System Architecture](./SYSTEM_ARCHITECTURE.md) and sequences with [Build Plan](./BUILD_PLAN.md). Today the repository contains only `docs/`; everything below is the structure the [Build Plan](./BUILD_PLAN.md) milestones fill in.

## 1. Monorepo vs polyrepo — the decision

We choose a **pnpm + Turborepo TypeScript monorepo**. The deciding argument is `packages/schema`: Nova's contracts (Context Moment shape, scopes, event taxonomy, API request/response types) must be *identical* across the extension, web app, API, workers, realtime gateway, and public SDK. In a polyrepo, that means a published internal package, version skew, and "works against schema 0.4.1 but prod is on 0.4.3" bugs — the worst kind for a platform selling contract stability. In a monorepo, a schema change and every consumer's adaptation land in one atomic PR, and Turborepo's task graph rebuilds exactly the affected packages.

Costs we accept: CI must be aggressively cached and task-graph-aware or it slows to a crawl (Turborepo handles this; we enforce remote caching from day one); repo access is all-or-nothing for contributors (fine — the SDK and examples are also published/mirrored publicly); and non-TypeScript components (future Tauri Rust core, Kotlin app) fit awkwardly. We keep those in the monorepo anyway under their app directories — coordination beats purity at this team size — and will revisit only if native-toolchain CI times become the bottleneck.

## 2. Annotated tree

```text
nova-context/
├── README.md                     # front door; links to every doc in docs/
├── package.json                  # root: workspace scripts, devDependencies only
├── pnpm-workspace.yaml           # workspace globs: apps/*, services/*, packages/*, examples/*
├── turbo.json                    # task graph: build/lint/typecheck/test pipelines + caching
├── .github/
│   └── workflows/                # CI (ci.yml), release (changesets), e2e-smoke on main
├── apps/                         # user-facing clients (deployables with a UI)
│   ├── extension/                # Chromium MV3 extension — WXT + React        [MVP]
│   ├── web/                      # Next.js — memory timeline, projects, action approvals  [MVP]
│   ├── desktop/                  # Tauri v2 — full-screen capture              [post-MVP]
│   ├── mobile-android/           # Kotlin — AccessibilityService/MediaProjection [post-MVP]
│   └── mobile-ios/               # Swift companion — share sheet, voice, review [post-MVP]
├── services/                     # backend deployables (no UI)
│   ├── api/                      # Fastify (Node 22) — REST /v1, auth, scopes   [MVP]
│   ├── workers/                  # BullMQ consumers — enrichment, embedding, action executors [MVP]
│   └── realtime/                 # WebSocket gateway — live sessions, SSE fan-out [MVP]
├── packages/                     # shared libraries (never deployed directly)
│   ├── schema/                   # Zod schemas + generated types — SINGLE SOURCE OF TRUTH
│   ├── model-router/             # provider-agnostic LLM/embedding routing
│   ├── context-engine/           # shared perception logic (frame prep, DOM extract normalization, ranking)
│   ├── sdk-ts/                   # @nova-context/sdk — the public TypeScript SDK (MIT)
│   ├── ui/                       # shared React components (extension + web)
│   └── config/                   # eslint, tsconfig, prettier presets consumed by all workspaces
├── docs/                         # these documents + docs/adr/ for decision records
├── infra/                        # docker-compose.dev.yml, deploy configs, terraform later
├── examples/                     # runnable SDK examples + sample external-assistant integration
├── e2e/                          # Playwright: extension + web end-to-end suites
└── tests/                        # (does not exist — see §3.8; tests live with their code)
```

## 2.1 Dependency rules — enforced, not aspirational

The tree only stays coherent if the import graph is policed. The allowed direction of dependencies:

```text
apps/*      ──▶  packages/ui, packages/schema, packages/sdk-ts, packages/context-engine
services/*  ──▶  packages/schema, packages/model-router, packages/context-engine
packages/ui ──▶  packages/schema
packages/sdk-ts ──▶ packages/schema
packages/model-router ──▶ packages/schema
packages/context-engine ──▶ packages/schema
packages/schema ──▶ (nothing in the workspace)
packages/config ──▶ (nothing; consumed as devDependency everywhere)
```

Hard rules, enforced by dependency-cruiser in the lint stage:

- **Nothing imports from `apps/` or `services/`.** Deployables are leaves. If a service grows something another workspace wants, that something moves to `packages/` first.
- **`packages/schema` imports nothing** from the workspace. It is the bottom of the graph; a cycle through schema would poison every build.
- **Apps never import server-only packages** (`model-router` runs server-side only — an app that needs model output calls a service).
- **No deep imports** across package boundaries (`@nova/schema/src/internal/…` is a lint error); packages expose a deliberate public surface via their root export.

These rules are cheap to enforce on an empty repo and nearly impossible to retrofit onto a tangled one, which is why they are in this document and in CI before any code exists.

## 3. Directory contracts

For each directory: purpose, key contents, and what does **not** belong there. The "not" lists are the part people actually need.

### 3.1 `apps/`

Deployable user-facing clients. Each app owns its build tooling, its platform-specific code, and nothing reusable.

| App | Key contents | Does NOT belong |
|---|---|---|
| `extension/` | WXT config, MV3 manifest, background service worker (capture orchestration, upload queue), content scripts (DOM extraction), React popup/side-panel; push-to-talk UI | Business logic that web/desktop also needs (→ `packages/context-engine`); API types (→ `packages/schema`); direct DB or queue access — the extension speaks only `/v1` |
| `web/` | Next.js app: memory timeline, project views, action-approval queue, consent/grant management, audit-log viewer | Server-side business logic beyond BFF glue — the web app is a client of `services/api`, not a second backend; shared components (→ `packages/ui`) |
| `desktop/` | Tauri v2 shell, Rust capture core (ScreenCaptureKit / Graphics.Capture bindings), React UI reusing `packages/ui` | Cloning extension logic — shared perception goes to `packages/context-engine`; Rust code that isn't capture/OS-integration |
| `mobile-android/` | Kotlin app: AccessibilityService, MediaProjection, overlay button; Kotlin SDK consumer | TypeScript; duplicated schema definitions (generated Kotlin types from `packages/schema` artifacts) |
| `mobile-ios/` | Swift companion: share-sheet extension, voice notes, memory review | Any pretense of full-screen observation — see the iOS reality in [System Architecture](./SYSTEM_ARCHITECTURE.md) |

`desktop/`, `mobile-android/`, `mobile-ios/` exist as empty scaffolds with a README stating their milestone until their [Build Plan](./BUILD_PLAN.md) phase starts — placeholder directories cost nothing and prevent structure debates later.

### 3.2 `services/`

Backend deployables. Each has a `Dockerfile`, its own `src/`, and integration tests (§3.8).

| Service | Key contents | Does NOT belong |
|---|---|---|
| `api/` | Fastify routes for `/v1`, OAuth 2.1 + token exchange, scope enforcement middleware, Drizzle ORM models, RLS session setup, webhook dispatch, presigned uploads | Long-running work (→ `workers/` via BullMQ); WebSocket handling (→ `realtime/`); schema definitions (imports `packages/schema`) |
| `workers/` | BullMQ consumers: enrichment (OCR cleanup, entity extraction), embedding, project-linking, action executors (Notion first), webhook retry/DLQ | HTTP endpoints (a health check is the sole exception); direct calls to model providers bypassing `packages/model-router` |
| `realtime/` | WS gateway for live sessions (frames up / insights down), SSE fan-out for `/v1/events`, session lifecycle enforcement (max duration, hard stop) | Persistence logic (delegates to `api`/queue); enrichment (streams to workers) |

### 3.3 `packages/`

Shared libraries. Rule of thumb: if two workspaces need it, it moves here; until then it stays where it's used. Premature extraction is how monorepos grow 40 half-baked packages.

- **`schema/` — the single source of truth.** Zod schemas for every entity, API request/response, event, and scope; OpenAPI + AsyncAPI generated *from* the Zod definitions; generated type artifacts for Kotlin/Swift consumers. Everything imports schema; **schema imports nothing** from other workspace packages. Any PR that changes an API contract touches this package first, which makes contract changes trivially greppable in review. Does NOT belong: runtime logic, HTTP clients, anything with side effects.
- **`model-router/`** — provider-agnostic LLM/embedding orchestration: routing by task/cost/latency/privacy tier, fallback chains, benchmarking harness ([Intelligence Engine](./INTELLIGENCE_ENGINE.md)). Does NOT belong: prompts specific to one worker's job (those live with the worker); API keys (env-injected).
- **`context-engine/`** — perception logic shared across capture clients and workers: frame preprocessing, DOM-extract normalization, redaction detectors, ranking. Does NOT belong: platform capture APIs (those are per-app); storage.
- **`sdk-ts/`** — the public `@nova-context/sdk` (MIT), generated clients + handwritten ergonomics, mock mode, published to npm via changesets. Does NOT belong: anything internal-only — this package is the public boundary and is held to the [12-month deprecation policy](./API_AND_SDK_SPEC.md).
- **`ui/`** — shared React components + design tokens for extension/web/desktop. Does NOT belong: app-specific screens; data fetching.
- **`config/`** — `@nova/eslint-config`, `@nova/tsconfig`, prettier preset. Does NOT belong: runtime code of any kind.

### 3.4 `docs/`

These twenty documents plus `docs/adr/` (§4.3). Does NOT belong: generated API reference (built from `packages/schema` into the docs site, not committed); meeting notes; anything private (briefs, credentials, partner terms).

### 3.5 `infra/`

Everything needed to run Nova locally and deploy it, and nothing that is application code.

```yaml
# infra/docker-compose.dev.yml — the whole dev stack in one command
services:
  postgres:            # Postgres 16 + pgvector, RLS enabled from the first migration
    image: pgvector/pgvector:pg16
  redis:               # BullMQ queues + rate-limit counters
    image: redis:7-alpine
  minio:               # S3-compatible object storage for media blobs
    image: minio/minio
  mailpit:             # catches consent/notification emails in dev
    image: axllent/mailpit
```

`pnpm dev` brings this up, runs migrations, seeds the synthetic sandbox dataset (the same one the SDK's mock mode uses — see [API & SDK Spec](./API_AND_SDK_SPEC.md)), and starts `api`, `workers`, and `realtime` in watch mode. A new contributor should reach a working capture flow in under fifteen minutes or the onboarding is broken, not the contributor.

Also here: Fly.io/Railway deploy configs per service, migration-runner config, and later `infra/terraform/` when we outgrow PaaS. Does NOT belong: application code; secrets — `.env.example` is committed, `.env` never, and CI fails on high-entropy strings in this directory.

### 3.6 `examples/`

Runnable, CI-compiled examples: minimal SDK usage scripts and **`assistant-integration/`** — a small but complete external assistant using Nova as substrate (token exchange, `memory/query` grounding with provenance display, `action:propose`, joining a live session). This example doubles as design-partner onboarding material and as an executable test that the SDK's public story actually works. Does NOT belong: anything imported by production code; snapshots that drift (examples build in CI or they get deleted).

### 3.7 `e2e/`

Playwright suites driving the built extension + web app against a compose-provisioned backend: capture → moment → project link → Notion action; live session start/indicator/hard-stop; consent and revocation flows. Does NOT belong: unit tests; API integration tests (§3.8).

### 3.8 Test layout (why there is no root `tests/`)

- **Unit tests: colocated** — `foo.ts` next to `foo.test.ts` (Vitest). Colocation keeps tests honest about module boundaries and makes deletion of dead code delete its tests.
- **Integration tests: inside each service** — `services/api/test/integration/`, running against compose-provisioned Postgres/Redis. They test the service's real boundary (HTTP in, DB/queue out), not mocks of it.
- **E2E: top-level `e2e/`** — the only cross-workspace suite, therefore the only one that earns a top-level directory.

## 4. Conventions

### 4.1 Naming

- Directories/files: `kebab-case`. React components: `PascalCase.tsx`. No `index.ts` barrel files except at package roots (barrels elsewhere wreck tree-shaking and make grep lie).
- Workspace package names: `@nova/<name>` for internal (`@nova/schema`), `@nova-context/<name>` for published (`@nova-context/sdk`).
- Database: `snake_case` tables/columns; Drizzle models mirror them; no ORM-side renaming cleverness.
- IDs: prefixed ULIDs (`cm_`, `prj_`, `act_`, `ses_`, `evt_`) as specified in [API & SDK Spec](./API_AND_SDK_SPEC.md).

### 4.2 Commits and branches

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`) with workspace scope: `feat(api): token exchange endpoint`. Enforced by commitlint in CI, not a local hook people disable.
- Trunk-based: short-lived branches off `main`, named `<type>/<slug>` (`feat/live-session-gateway`). No long-lived `develop` branch — release channels are handled by changesets, not branch topology.
- PRs: small, one concern; description says *why*; CI green + one review to merge; squash-merge so `main` history is one commit per PR. Contract-changing PRs (anything touching `packages/schema`'s public surface) require a second reviewer.

### 4.3 ADRs

Architecture Decision Records live in `docs/adr/NNNN-title.md` (`0001-postgres-pgvector-over-dedicated-vector-db.md`), template: Context / Decision / Alternatives considered / Consequences / Status. **Required** when a decision is expensive to reverse or crosses workspace boundaries: storage choices, queue/broker changes, auth flows, public API shape, capture pipeline changes, new external dependencies with data access. Also required: the privacy-review appendix for anything touching capture/memory/retention/third-party access, per [Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md). Not required for reversible, workspace-local choices — an ADR process that fires on everything gets ignored for the decisions that matter. Superseded ADRs are marked, never deleted.

### 4.4 Versioning and releases

**Changesets** with independent per-package versions. Internal packages version freely; consumers in-repo always build against workspace HEAD, so internal version numbers are bookkeeping, not compatibility contracts. The packages where versioning *is* the contract: `@nova-context/sdk` (semver, strictly — a major bump is a deprecation-policy event per [API & SDK Spec](./API_AND_SDK_SPEC.md)) and the API itself (versioned by URL path `/v1`, not by package). Services deploy from `main` by digest; they are not "versioned" in the npm sense.

### 4.5 CI pipeline

One workflow, Turborepo-driven, only affected workspaces run. Stages, in order:

| Stage | Runs | Gate |
|---|---|---|
| 1. lint | eslint + prettier check, commitlint, dependency-cruiser (import rules, §2.1) | Blocks everything downstream |
| 1′. security (parallel with lint) | dependency audit (`pnpm audit` + osv-scanner), secret scan (gitleaks) | A repo that will hold capture code does not get to skip these |
| 2. typecheck | `tsc -b` across affected workspaces | — |
| 3. unit | Vitest, affected packages only, coverage reported not gated (coverage gates breed test theater) | — |
| 4. integration | Per-service suites against compose-provisioned Postgres/Redis/MinIO | — |
| 5. e2e-smoke | Playwright critical paths (capture → moment → action; consent revocation) on PRs; the full e2e matrix runs nightly and on `main` | — |

Sketch of the workflow shape:

```yaml
# .github/workflows/ci.yml (abbreviated)
jobs:
  lint:      { steps: [pnpm turbo lint] }
  security:  { steps: [osv-scanner, gitleaks] }
  typecheck: { needs: [lint], steps: [pnpm turbo typecheck] }
  unit:      { needs: [typecheck], steps: [pnpm turbo test -- --changed] }
  integration:
    needs: [unit]
    services: { postgres: pgvector/pgvector:pg16, redis: redis:7 }
    steps: [pnpm turbo test:integration]
  e2e-smoke: { needs: [integration], steps: [pnpm turbo e2e:smoke] }
```

Merge requires all stages green. Remote Turborepo caching is mandatory from the first week; a cold-cache full pipeline should stay under 15 minutes — when it doesn't, we fix the pipeline, not the expectation. Release publishing (`sdk-ts` to npm) runs on `main` via the changesets action, never from laptops.

### 4.6 Environment and configuration

- **All runtime config through environment variables, validated at boot** with a Zod schema per service (`services/api/src/env.ts`). A service with a missing or malformed variable crashes at startup with a named error — never limps along with `undefined` reaching a query.
- `.env.example` is committed per service and is the documentation of record for its configuration; `.env` is gitignored everywhere; production secrets live in the deploy platform's secret store, never in the repo or CI variables that echo into logs.
- **Feature flags are config, not branches.** Unfinished work ships dark behind an env-gated flag rather than living on a long-running branch; flags are deleted within one milestone of full rollout or they become permanent config nobody understands.
- **One Node version** (22.x) pinned in `.nvmrc` and `package.json#engines`, enforced by pnpm's `engine-strict`. One pnpm version pinned via `packageManager`. Version drift across contributors is a solved problem; we keep it solved.

### 4.7 PR checklist (the short version reviewers actually apply)

1. Does this change an API contract? Then `packages/schema` changes in the same PR, and a second reviewer signs off.
2. Does this touch capture, memory, retention, or third-party access? Then the privacy-review appendix exists per [Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md), or the PR waits.
3. Do new dependencies pull their weight? Every new package in a capture-adjacent workspace is supply-chain surface; "it saved 20 lines" is not an argument.
4. Are the tests where the code is (§3.8), and do they test the boundary rather than the mock?

## 5. What exists now vs what gets built

| State | Contents |
|---|---|
| **Now** | `README.md`, `docs/` (these documents). No code, no `package.json` yet. |
| **[Build Plan](./BUILD_PLAN.md) — prototype (30d)** | Root workspace scaffolding, `packages/schema` + `config`, `apps/extension`, `services/api` (minimal), `infra/docker-compose.dev.yml`, CI through `unit` |
| **MVP (90d)** | `services/workers`, `services/realtime`, `apps/web`, `packages/model-router` + `context-engine` + `ui`, `e2e/`, full CI |
| **6–12 months** | `apps/desktop`, `packages/sdk-ts` published, `examples/assistant-integration`, `docs/adr/` accumulating, `infra/terraform` |
| **Later** | `apps/mobile-android`, `apps/mobile-ios`, per the [Roadmap](./ROADMAP.md) |

The structure is deliberately a size or two larger than the prototype needs. That is the point: the first line of code should land in a place chosen when we were thinking clearly, not wherever was closest at 2 a.m.
