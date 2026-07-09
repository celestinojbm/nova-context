# Roadmap

**Why this document.** This roadmap exists to force sequencing discipline: Nova Context's vision spans every platform and a developer ecosystem, and the fastest way to ship none of it is to build toward all of it at once. Each horizon below states goals, deliverables, success metrics with numbers, team assumptions, risks, and — as importantly — explicit non-goals. The scope decisions referenced here are canonical in [MVP_SCOPE.md](./MVP_SCOPE.md); build order detail is in [BUILD_PLAN.md](./BUILD_PLAN.md); the revenue timing this enables is in [BUSINESS_MODEL.md](./BUSINESS_MODEL.md).

The spine, in one view:

```
 30 days    Prototype: extension capture → moment → voice → Notion action
 90 days    MVP + private alpha (~25 users)
 6 months   Public beta + desktop app (Tauri) + API v0 (design partners, Dona first)
 12 months  Developer platform GA + Android + Teams tier
 3 years    Context layer for major assistants + enterprise + iOS-within-constraints + marketplace
 10 years   Ambient context infrastructure standard
```

---

## Horizon 1 — Prototype (30 days)

**Goal.** Prove the core loop end-to-end with real components, no mocks: invoke in browser → capture visible tab + DOM extract → speak intent → Context Moment stored → action lands in Notion. One hardcoded project. Ugly is fine; fake is not.

**Deliverables.**
- Chromium MV3 extension: toolbar/shortcut invocation, `captureVisibleTab` + DOM extraction, push-to-talk audio.
- Minimal backend (Fastify, Postgres+pgvector, BullMQ): ingestion, cloud ASR, one LLM extraction pass, moment storage.
- Notion integration: capture → task/page, preview-then-confirm.
- Crude timeline page (list view) to see stored moments.

**Success metrics.** The founder uses it daily by day 21 for real work; invoke-to-confirmed under 30s; 20 consecutive captures without a lost utterance; 5 outside demos where the observer asks to install it.

**Team.** 1–2 people (founder + at most one engineer).

**Key risks.** Capture latency makes the loop feel bad (mitigate: measure from day 1, budget every hop); MV3 service-worker lifecycle eats audio sessions (mitigate: offscreen document pattern early); extraction quality poor enough that confirmations always need edits.

**Non-goals.** No auth beyond a token, no project inference, no Live Context Mode, no design polish, no second integration, no users other than us.

---

## Horizon 2 — MVP + private alpha (90 days)

**Goal.** The MVP as scoped in [MVP_SCOPE.md](./MVP_SCOPE.md), in the hands of ~25 outside users, generating the retention and behavior data that decides everything after.

**Deliverables.**
- Instant Capture complete: project auto-suggest + confirm, Nova task list, Notion integration, confirmation card at full quality.
- Live Context Mode, bounded: tabCapture sessions, 60s buffer, 1 fps sampling + tab audio transcript, push-to-talk Q&A grounded in buffer, "save this" promotion, 30-min cap, visible indicator.
- Next.js web app: memory timeline (browse/search/filter), project view, action review.
- Real auth (OAuth 2.1 + PKCE), per-user audit log, delete-that-cascades.
- Onboarding that gets a stranger to first capture in under 5 minutes.

**Success metrics (alpha bar).** 25 active alpha users; **>3 captures/user/week** at week 4 (habit signal); **>40% of captures linked to projects** (validates that linking, the core differentiator over screenshots, is used); **capture-to-action <30s** p75; week-4 retention >50%; at least 5 users who complain when it breaks (the real engagement metric). Instrument the theory's falsification test: retrieval/action rates of captures with vs. without intent utterances.

**Team.** 2–3 (founder + 1–2 engineers).

**Key risks.** Alpha users capture but never revisit (memory without retrieval = novelty toy — mitigate: weekly-review surface, search quality focus); ASR quality on accented/noisy speech breaks the spine interaction; cloud costs per user surprise us (mitigate: per-user cost dashboard from day 1).

**Non-goals.** No mobile, no wake word, no cross-device beyond one browser + web app, no marketplace, no multi-model consensus (primary + one fallback only), no knowledge-graph UI, no enterprise anything, no local LLM, no payments (alpha is free).

---

## Horizon 3 — Public beta + desktop + API v0 (6 months)

**Goal.** Escape the browser's walls, open the doors, and put the first external developer on the API.

**Deliverables.**
- **Desktop app (Tauri v2)**, macOS first then Windows: full-screen capture via ScreenCaptureKit/Graphics.Capture, accessibility-tree extraction, floating button + global shortcut, permission onboarding that survives macOS 15+ re-consent flows.
- **Project intelligence:** cross-moment project summaries, "catch me up on this project," improved link suggestion from accumulated data.
- **Public beta:** open signup, Free/Pro billing live (validates §2 of [BUSINESS_MODEL.md](./BUSINESS_MODEL.md)), fair-use enforcement, status page, support loop.
- **API v0:** context read/capture + memory query + action propose, scoped keys, for 2–3 hand-held design partners — **Dona first**. Webhooks for moment-created/action-completed.

**Success metrics.** 2,000 beta signups, 500 WAU; free→Pro conversion >4% by month 2 of billing; desktop DAU >35% of total (validates desktop demand); Dona integration live in their product with >1 real feature shipped on Nova; capture p75 <15s on desktop.

**Team.** 5–7 (2 product eng, 1 desktop/Rust, 1 backend/infra, 1 API/DX, founder + design contract).

**Key risks.** Desktop permission friction kills activation (mitigate: obsessive onboarding UX, fall back to browser-only value); Tauri v2 ecosystem gaps cost weeks (accepted tradeoff — revisit Electron only if blocked hard); API v0 too early and design-partner support consumes the team (mitigate: hard cap at 3 partners); paying users change our risk tolerance on data handling before enterprise-grade ops exist.

**Non-goals.** No Android yet, no self-serve API signup, no SDK GA (partner-only), no Teams tier, no Firefox/Safari, no marketplace.

---

## Horizon 4 — Developer platform GA + Android + Teams (12 months)

**Goal.** Nova becomes three businesses at once — consumer product on a second OS, self-serve developer platform, and first B2B revenue — without dropping any of them.

**Deliverables.**
- **Developer platform GA:** self-serve keys, metered billing (three meters per [BUSINESS_MODEL.md](./BUSINESS_MODEL.md) §3), free dev tier, TypeScript SDK 1.0 (open source), docs + quickstarts, OAuth scopes finalized (`context:read` … `action:execute`), rate limits, dev dashboard.
- **Android app:** floating overlay button, MediaProjection capture with persistent notification, AccessibilityService extraction (with a capture path that degrades gracefully if Play policy forces changes), share-sheet capture, full timeline/review parity.
- **Memory graph:** entity/edge layer (relational tables, per architecture) powering people views, provenance display, cross-project connections.
- **Teams tier:** shared projects, team memory search with per-moment visibility, admin console, billing.

**Success metrics.** 10,000 WAU consumer; 200+ registered API developers, 20+ apps with production traffic, first $10K+/mo platform revenue; Android >25% of new activations within a quarter of launch; 30+ team workspaces, team logo retention >85% at 90 days; SDK npm installs growing month-over-month.

**Team.** 10–14 (platform team of 3–4, Android team of 2–3, core product 3–4, infra/SRE 1–2, first GTM hire).

**Key risks.** **Play Store policy on AccessibilityService** — the single biggest external risk this horizon; a policy shift or rejection can force capture-path redesign (mitigate: MediaProjection-primary architecture, accessibility as enhancement; policy pre-review; relationship with Play developer relations). Three-front execution stretches a ~12-person team — the classic failure is all three at 70%. Metered billing correctness (usage disputes destroy developer trust faster than outages).

**Non-goals.** No iOS beyond the share-sheet companion shipped quietly for capture-anywhere users; no enterprise (SSO/VPC) commitments; no marketplace; no OEM deals (conversations yes, contracts no); no additional SDK languages until TS SDK proves the pattern.

---

## Horizon 5 — Platform maturity (3 years)

**Goal.** Nova as the context layer major assistants actually ship on, plus the enterprise tier, the marketplace, and iOS pushed to the boundary of what Apple permits.

**Deliverables.**
- Context-layer integrations with 3+ major assistant/agent products beyond design partners (their users' cross-app memory runs on Nova).
- **Enterprise:** SSO/SAML, SCIM, VPC/self-host deployment, audit export, DPA/residency, DLP hooks — see [SECURITY_MODEL.md](./SECURITY_MODEL.md).
- **iOS within constraints:** best-in-class companion (share-sheet capture, App Intents/Shortcuts, voice notes, full review/search), stated plainly as a companion; active pursuit of Apple partnership conversations for anything deeper.
- **Marketplace:** plugin/integration listings, 80/20 rev-share, security/quality review pipeline.
- Kotlin/Swift/Python SDKs; NATS/Kafka-class event backbone; multi-region.

**Success metrics.** Platform revenue >30% of total and growing faster than subscriptions; 100K+ WAU across surfaces; 10+ enterprise logos with >$1M cumulative ARR from the tier; 100+ marketplace listings with meaningful developer earnings; assistant-vendor churn of zero (nobody who integrated leaves — the stickiness proof).

**Team.** 30–60.

**Key risks.** OS vendors ship "good enough" native context features (Apple Intelligence, Android system-level memory) — mitigation is cross-platform neutrality and depth: an OS feature is single-OS by construction and serves the OS vendor's assistant first; assistants pick a big-model memory API as default context (mitigation: Switzerland position + deeper capture surface than any single model vendor will build); enterprise sales bending the roadmap around whales (mitigation: enterprise features gated on 3+ concurrent customer demand).

**Non-goals.** Still no Nova-branded general assistant (permanently — it would end platform neutrality, per [BUSINESS_MODEL.md](./BUSINESS_MODEL.md) §5); no hardware; no acquisition-driven sprawl into note-taking/PM app categories.

---

## Horizon 6 — Ambient context infrastructure standard (10 years)

**Goal.** "Context provider" becomes a category the way "OAuth provider" is one — and Nova defines it. Users carry one context identity across assistants, devices, OSes, wearables, and robots; granting an agent access to your context is as normal and as scoped as "Sign in with…" is today.

**Directional deliverables (a heading, not a plan).** An open context-interchange protocol (scopes, consent, portability) that we author and others implement — opening the protocol is deliberate: a standard we control alone will be routed around, and by this stage protecting the category beats protecting the moat; OS-level partnerships making Nova a system-integrated provider; wearable/robotics context feeds (embodied agents need exactly this substrate); regulatory-grade infrastructure certifications in major markets.

**Success looks like.** A meaningful fraction of AI-assistant interactions in developed markets touching a Nova-held context layer; the protocol implemented by at least one party we don't control; "does it support Nova?" as a question buyers ask of assistants, not the reverse.

**Honesty clause.** Ten-year plans are direction, not commitment. Everything here past the protocol idea is scenario, and the scenario assumes horizons 3–5 landed. The reason to write it down anyway: near-term architecture (scoped permissions, provenance, portability, neutrality) must not foreclose it, and every horizon above was checked against that test.

---

## Dependencies: what gates what

```
Prototype loop quality ──► Alpha (no point recruiting users for a bad loop)
Alpha retention data ────► Public beta + billing (pricing needs usage truth)
Consumer capture proven ─► API v0 (can't sell context ops nobody generates)
API v0 partner learnings ► Platform GA (scopes/webhooks shaped by real use)
Desktop maturity ────────► Android (reuse perception pipeline, one new OS at a time)
Teams usage patterns ────► Enterprise (security posture built on real multi-tenant load)
Platform GA + traction ──► Marketplace (no ecosystem without developers)
Everything above ────────► OEM (nobody embeds unproven infrastructure)
```

Two rules the dependency graph enforces: **no horizon starts its flagship deliverable until the gating evidence exists** (e.g., if alpha shows <2 captures/user/week, we fix the loop instead of building desktop), and **platform work never leapfrogs consumer proof** — the API monetizes a behavior that must first demonstrably exist.

## Assumptions that could break this roadmap

Stated so we notice when one moves, rather than discovering it in a postmortem:

1. **Play Store policy** continues to allow AccessibilityService + MediaProjection capture for user-invoked tools with disclosure. A hard policy turn makes Android capture materially worse and delays Horizon 4. Leading indicator: policy bulletins, peer-app rejections. Contingency: MediaProjection-only capture, deeper share-sheet path.
2. **ASR and vision costs keep falling.** Unit economics (§6 of [BUSINESS_MODEL.md](./BUSINESS_MODEL.md)) work at today's prices but Live Context margins assume the historical cost curve continues. A plateau — or model-vendor pricing power concentrating — squeezes Pro margin and forces either price increases or heavier on-device processing earlier than planned.
3. **Apple does not open screen observation on iOS** (base assumption — the roadmap survives it), but also **does not close the share sheet / App Intents surface further**. Further tightening reduces iOS to review-only. Partnership remains the only path to full iOS Nova; probability low, planned as upside only.
4. **Assistant vendors want a neutral layer** rather than each building proprietary memory and accepting the cross-app blindness. If the top 2–3 vendors solve cross-app context unilaterally (via OS deals we can't get), the platform TAM shrinks to the long tail — still a business, not the 10-year story.
5. **No regulatory shock** reclassifies user-invoked screen capture as intercept-regulated in major markets. GDPR/CCPA compliance is planned cost; a wiretap-style reinterpretation of screen context would require consent-flow redesign per jurisdiction.
6. **Trust holds.** One serious breach or dark-pattern scandal in this category — ours or a competitor's spilling onto us — resets adoption by quarters. This is why [PRIVACY_AND_TRUST.md](./PRIVACY_AND_TRUST.md) commitments are engineering requirements with the same standing as uptime.

## Related documents

- [MVP_SCOPE.md](./MVP_SCOPE.md) — canonical scope for Horizons 1–2
- [BUILD_PLAN.md](./BUILD_PLAN.md) — week-level build order
- [BUSINESS_MODEL.md](./BUSINESS_MODEL.md) — the revenue engines each horizon unlocks
- [PRODUCT_VISION.md](./PRODUCT_VISION.md) — the experience this sequencing delivers
- [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md) — the architecture the dependency graph assumes
