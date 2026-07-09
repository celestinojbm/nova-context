# Business Model

**Why this document.** Nova Context is infrastructure, and infrastructure businesses die two ways: by never finding a wedge users pay for, or by monetizing in a way that poisons the trust the infrastructure runs on. This document lays out how we make money at each stage — consumer subscriptions first, metered platform revenue as the real long-term engine — with unit-economics reasoning, explicit pricing hypotheses (labeled as hypotheses), and a short list of things we will never do regardless of how the numbers look. Product context is in [PRODUCT_VISION.md](./PRODUCT_VISION.md); the API surface this monetizes is specified in [API_AND_SDK_SPEC.md](./API_AND_SDK_SPEC.md); timing is in [ROADMAP.md](./ROADMAP.md).

## 1. The shape of the business

Two revenue engines, sequenced:

1. **Direct subscriptions (now → always):** individuals and teams paying for Nova's own capture/memory/action product. This funds the company to product-market fit and keeps us honest — we must be good enough that end users pay.
2. **Platform revenue (12 months →):** metered API fees from assistants and applications that use Nova as their context/memory/action substrate, plus marketplace rev-share and eventually OEM licensing. This is the larger prize: every assistant needs persistent cross-app context, none of them owns it, and a neutral provider can serve all of them.

The sequencing matters. Platform revenue requires the consumer product to have proven the capture loop works and to have generated the integration surface. Selling API access to a context engine no human uses is selling vapor.

## 2. Subscription tiers

At a glance:

| Tier | Price | For | The one-line pitch |
|---|---|---|---|
| Free | $0 | Trying the loop | Full-quality capture, capped volume |
| Pro | ~$15/mo | Individual operators | Unlimited capture, all devices, all integrations |
| Teams | ~$25/user/mo | 5–200 person companies | Shared project memory |
| Enterprise | Custom | Security-first orgs | SSO/SCIM, VPC/self-host, audit, DPA |

### Free — the honest hook

**Who it's for:** anyone curious; students; the person who saw a demo and wants to feel the loop.

**What's included:**
- Full Instant Capture experience, capped at **100 Context Moments/month**
- Live Context sessions capped at 10/month (30-min cap as everywhere)
- 90-day retention on moments not linked to a project; project-linked moments are kept
- 1 integration (Notion *or* GitHub)
- Single device + web app; community support

**Why capped this way:** the aha moment is roughly ten good captures — the first time search surfaces a moment you'd forgotten, the first time a capture becomes a done task. 100 moments/month is ~3/day: comfortably enough to *live* the habit for a month, deliberately not enough for the habit at full intensity (our target power users run 8–15/day). The cap converts on volume of value received, not on crippled features. What we refuse to cap: capture quality, voice intent, or the confirmation flow — a free tier that captures badly would teach users the product is bad, not that it's worth paying for.

### Pro — ~$15/month

**Who it's for:** the individual operator — founder, researcher, creator, engineer, student-power-user — whose projects live across a browser, a desktop, and a phone.

**What's included:**
- Unlimited capture within fair use (fair use ≈ human-generated volume; we publish the number, currently ~2,000 moments/month soft ceiling, because "unlimited*" without a printed asterisk is how trust dies)
- All integrations; cross-device sync
- Full retention with user-controlled policies; local-only projects
- Longer Live Context sessions
- Priority model routing (faster captures at peak)

**Why $15:** above the $8–10 impulse tier because Nova is a daily workflow tool, not a nice-to-have; below the $20+ of the assistants themselves because Nova complements rather than replaces them, and many users will pay for both. $15 also clears our unit costs by a wide margin (§6), leaving room to get model-price surprises wrong without repricing. Hypothesis to validate in beta with real willingness-to-pay data, not a sacred number.

### Teams — ~$25/user/month

**Who it's for:** 5–200 person companies where context loss is an organizational bleed: decisions made in meetings nobody can reconstruct, research one person did that four people redo.

**What's included:**
- Everything in Pro
- Shared projects: team members' captures compose into one project memory
- Team memory search with per-moment visibility controls — private by default; a capture is the capturer's until they share it
- Decision records as first-class shared artifacts
- Admin console, centralized billing, SLA'd support

**Why $25:** the delta over Pro prices the network value — a team's shared project memory is worth more than the sum of individual memories — and matches the $20–30/user band where team knowledge tools (Notion, Linear, Slack tiers) already clear procurement without a sales call. Self-serve first; sales-assisted above ~50 seats.

### Enterprise — custom pricing

**Who it's for:** organizations whose security posture, not feature list, is the buying criterion — finance, health, legal, government-adjacent.

**What's included:**
- SSO/SAML + SCIM provisioning
- VPC deployment or full self-hosting
- Org-wide audit export, DPA, regional data residency
- Custom retention/DLP policies
- Model-routing controls: "no context leaves our tenant," on-prem model endpoints
- Dedicated support; security review cooperation

**Why custom:** deployment cost variance is genuinely enormous (a managed multi-tenant seat vs. a self-hosted VPC install differ by an order of magnitude in our cost), and enterprise buyers expect to negotiate. Floor pricing roughly 2–3× Teams per seat with platform minimums. We do not chase enterprise before the 3-year horizon ([ROADMAP.md](./ROADMAP.md)) — enterprise sales before product maturity would bend the roadmap around one whale's feature list.

## 3. API pricing — the platform meter

SDKs are free; the meter is at the API (§4). Three billable primitives, matching the three engines a client actually consumes:

| Meter | Unit | What it covers |
|---|---|---|
| Context operations | per operation | Ingest/enrich a moment, retrieval query, ranking call, live-session minute (billed as operation bundles) |
| Memory storage | per GB-month | Stored moments, embeddings, media — after processing, at rest |
| Action executions | per execution | Action Engine runs on behalf of the client app (Tier 0–2), including integration calls |

**Free developer tier:** 5,000 context operations, 1 GB-month, 500 action executions per month, full API surface, no card required. Generous enough to build and demo a real integration; the meter starts where production traffic starts.

**Illustrative pricing (hypotheses, not commitments):**

| Meter | Dev tier | Usage price (illustrative) |
|---|---|---|
| Context operations | 5,000/mo free | $2.00 per 1,000 ops, volume-discounted to ~$0.80 at 10M+/mo |
| Memory storage | 1 GB-mo free | $0.40 per GB-month |
| Action executions | 500/mo free | $10 per 1,000 executions |

**Honest caveat:** these numbers are anchored to today's inference and storage costs plus a target platform gross margin of ~70%. Both anchor points will move — inference prices have been falling 5–10× every 18 months, and our own cost per operation will drop as routing improves. Treat the table as a pricing *structure* we're committed to (three meters, free dev tier, volume discounts) and the numbers as hypotheses we will validate with the first design partners and revise publicly.

What we commit to now, regardless of where the numbers land:

- No per-seat charge for API access.
- No charging for failed operations.
- 12-month price protection for design partners.

## 4. SDK licensing

TypeScript SDK first, then Kotlin/Swift/Python — all **free and open-source (MIT or Apache-2.0)**. The reasoning is standard but worth stating:

- SDKs are distribution, not product. Every dollar of friction at the SDK layer costs a hundred at the meter.
- Open source lets integrators audit exactly what leaves their process — for a context platform, the SDK being inspectable is a trust feature, not a generosity.
- Revenue happens at the API meter; the SDK's job is to make reaching the meter a 30-minute experience.

We accept the standard costs: maintaining public repos, fielding community PRs, and forks (a fork without our backend is a client library for nothing).

## 5. Marketplace, OEM, and the developer ecosystem

### Marketplace

Third-party plugins and integrations, in three categories:

- **Capture sources** — new platforms, specialized apps
- **Action targets** — CRMs, PM tools, niche workflows
- **Memory processors** — domain-specific extraction (legal citations, medical terms), subject to strict data-handling review

Paid plugins split **80/20** — the developer keeps 80%. We take the smaller cut because the marketplace's job is ecosystem gravity, not margin; 30% platform taxes are resented rents and we don't need one. Every listing passes review: security (scoped permissions, no context exfiltration beyond declared scope — enforced technically by API scopes, verified by review), quality, and honest description. Review capacity is a real cost we accept; a marketplace with one data-leaking plugin destroys the platform. Timing: 3-year horizon, after developer platform GA proves third-party demand exists.

### OEM partnerships

The long-term structural play: assistant vendors and device makers licensing Nova as their embedded context layer — the assistant ships with persistent cross-app memory "inside," powered by Nova under revenue-share or per-device/per-MAU licensing. This includes the eventual wearables/robotics wave, where every embodied agent needs exactly what we build and none of those companies wants to build it. Honest sequencing: OEM conversations are earned, not pitched — nobody embeds infrastructure that hasn't proven itself at consumer and API scale first. We expect zero OEM revenue before year 3 and model none.

### Why assistants integrate (the developer ecosystem strategy)

An assistant integrating Nova gets, in one API:

1. **Persistent memory across sessions *and across apps*** — the thing every assistant's users complain about and every platform's sandbox prevents them from building.
2. **Screen-context grounding** — "what the user was looking at" — without building per-OS capture stacks.
3. **Risk-tiered action execution** with human approval built in.

Their alternative is building a context stack per platform, forever, while their competitors do the same redundantly.

The go-to-market is a **design-partner motion, starting with Dona.** Dona integrates at API v0 (6-month horizon), co-designs the scopes and webhooks against real usage, and gets deep integration support plus locked pricing in exchange for being the reference case. Two or three more design partners follow before GA. We sell the pattern with evidence, not slideware.

### The Switzerland position

The reason this platform can exist at all: **Nova is not a competing assistant.** OpenAI will not build on Google's memory layer; Google will not build on OpenAI's. A context layer owned by any assistant vendor is a strategic dependency none of its competitors will accept. Nova has no assistant, no chat product, no consumer AI brand competing for the same user relationship — we are the layer *under* all of them.

Neutrality is a structural asset we protect deliberately:

- No exclusive deals with any single assistant vendor.
- No preferential context access for anyone, including hypothetical future Nova products.
- Model-agnostic routing — the [Intelligence Engine](./INTELLIGENCE_ENGINE.md) treats every provider as a supplier, not a partner.

If we ever shipped our own general assistant, the platform business would die that day. So we won't.

## 6. Unit economics sketch

Directional numbers to prove the margin structure exists — all costs stated at today's prices, which is the conservative direction given model-cost trends.

**Cost per Instant Capture (cloud path, today's prices):**

| Component | Est. cost |
|---|---|
| ASR (~10s utterance, Whisper-class) | ~$0.001 |
| Vision+reasoning over 1–3 frames + DOM extract (mid-tier model via router) | ~$0.005–0.015 |
| Embeddings (text + visual) | ~$0.0005 |
| Queue/compute/db overhead | ~$0.001 |
| **Total per capture** | **~$0.01–0.02** |

**Cost per user-month:**

- **Free** (30 moments/mo actual median): ~$0.30–0.60 inference + ~$0.02 storage → under $1. Sustainable as pure funnel.
- **Pro** (300 moments/mo heavy user, some live sessions): ~$3–6 inference + ~$0.10–0.25 storage (0.25–0.6 GB processed data at ~$0.40/GB-mo blended) + sync/egress ≈ **$4–7 COGS** against $15 → **55–73% gross margin** at today's model prices, before routing optimizations (cheap models for easy extractions, local embeddings) that we expect to cut inference cost 2–3×.
- **Live Context is the margin risk:** a 30-min session at 1 fps + continuous ASR costs ~$0.30–0.80. Session caps and per-tier session quotas exist for cost honesty, not just UX.

**Storage** is the compounding cost, and the theory's decay model (see [THEORY_OF_HUMAN_DIGITAL_CONTEXT.md](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md), §5) is also the cost model: raw frames compress to thumbnails + extractions after their half-life, so per-user storage grows sublinearly with tenure. Without decay-driven compression, storage would eat the margin by year 3; with it, steady-state Pro storage cost stays under $0.50/month.

**Platform margins** target ~70% at the meter — inference passed through with margin, storage priced above blended cost, actions priced on orchestration value. Fragile to model-price shifts in both directions; annual repricing expected and stated in the API terms.

## 7. What we will not do

These are constraints, not aspirations. They hold even when a quarter looks bad.

1. **No advertising.** An ad business monetizes attention and profiling; our entire product is a promise that captured context serves only the user. The two cannot coexist in one company.
2. **No selling or sharing user context data.** Not "anonymized," not "aggregated insights," not to "trusted partners." User context is not inventory. Ever.
3. **No training on user context without explicit, granular, revocable opt-in.** Default is off. Opt-in is per-purpose, plainly described, and withdrawable with effect. No dark-pattern consent, no opt-in buried in ToS updates.
4. **No covert capture, on any tier, at any price.** No enterprise "employee monitoring mode." Companies asking for silent workforce surveillance will be declined — that market is real, lucrative, and corrosive to everything else we sell.
5. **No pay-to-rank in the marketplace and no exclusivity deals that break platform neutrality** (§5).

These also function as commercial positioning: for Enterprise buyers and OEM partners, "the context layer that structurally cannot monetize your data" is the differentiator that closes.

## 8. Related documents

- [PRODUCT_VISION.md](./PRODUCT_VISION.md) — what the tiers are buying
- [API_AND_SDK_SPEC.md](./API_AND_SDK_SPEC.md) — the API surface behind the meters
- [INTELLIGENCE_ENGINE.md](./INTELLIGENCE_ENGINE.md) — the routing that controls inference cost
- [SECURITY_PRIVACY_GOVERNANCE.md](./SECURITY_PRIVACY_GOVERNANCE.md) — §7 in binding detail
- [ROADMAP.md](./ROADMAP.md) — when each revenue engine turns on
