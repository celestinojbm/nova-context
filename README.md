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

**M1 — voice, intent, projects, tasks.** The full thread now runs:

> Browser extension captures the visible tab → user speaks (push-to-talk → Whisper transcript, editable) or types an instruction → the Intelligence Engine parses it into a structured intent (LLM with deterministic heuristic fallback) → Nova suggests a project (rule-based, user confirms or overrides — overrides logged) → Postgres stores the Context Moment with its intent → a Tier-0 Nova task is auto-created when the intent calls for one → timeline and task list display it all.

What exists today:

- 19 foundation documents (indexed below), internally consistent on vocabulary, architecture, and scope.
- A locked MVP definition ([MVP Scope](docs/MVP_SCOPE.md)) and a sequenced build plan ([Build Plan](docs/BUILD_PLAN.md)).
- The monorepo per [Repo Structure](docs/REPO_STRUCTURE.md): `packages/schema` (Zod contracts), `packages/model-router` (provider-agnostic intent parsing + transcription with fallback chains), `services/api` (Fastify + Postgres/pgvector), `apps/extension` (WXT MV3 side panel with push-to-talk), `apps/web` (Next.js timeline + tasks), `infra/` (dev compose stack), plus unit and integration tests.
- Both model providers are optional: no `OPENAI_API_KEY` → transcription returns 503 and the UI degrades to typed input; no `ANTHROPIC_API_KEY` → intent parsing uses the local heuristic parser.

Deliberately not built yet (per [Build Plan §14](docs/BUILD_PLAN.md)): Notion/external integrations, async enrichment workers, embeddings, live context mode, real auth. Those are M2–M3.

### Getting started (M0)

```bash
pnpm install
pnpm db:up            # Postgres 16 + pgvector, Redis (Docker)
pnpm db:migrate       # applies schema + seeds the single dev user
pnpm --filter @nova/api dev     # API on :3001
pnpm --filter @nova/web dev     # timeline on :3000
pnpm --filter @nova/extension build   # then load apps/extension/.output/chrome-mv3 via chrome://extensions → Load unpacked
```

Tests: `pnpm test` (unit) and `DATABASE_URL=postgres://nova:nova@localhost:5432/nova pnpm test:integration`. Configuration is documented in each workspace's `.env.example`.

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
