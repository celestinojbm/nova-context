# First Principles

**Why this document.** Nova Context will face thousands of design decisions this document cannot anticipate. What it can do is fix the small set of definitions and commitments from which those decisions should be derived — so that when a future choice is hard, we argue from principles rather than taste, and when a proposal violates one, the burden of proof sits on the proposal.

Each principle below has three parts: the **statement**, the **reasoning**, and the **design consequences** we accept — including the costs. If a consequence listed here ever feels inconvenient, that's the principle working.

Related: [The Context Manifesto](./THE_CONTEXT_MANIFESTO.md) argues the worldview these principles come from; [Theory of Human Digital Context](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md) formalizes the definitions; [Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md) turns several of these into enforcement mechanisms. Back to the [README](../README.md).

---

## Principle 1 — Context is perception + meaning + intent + connection + time

**Statement.** Context is what the user perceived, plus what it means, plus why it mattered to them at that moment, plus what it connects to, plus when and in what situation it occurred. All five, together, as one unit. A capture missing any component is not context — it is a fragment, and fragments are what every failed tool class already produces.

**Reasoning.** The five components are not a taxonomy for its own sake; each one is the specific thing whose absence kills an existing tool ([Manifesto §2](./THE_CONTEXT_MANIFESTO.md)):

- Screenshots have perception without meaning or intent.
- Notes have meaning and intent at a manual cost nobody pays.
- Bookmarks have a pointer and nothing else.

The failure pattern is always a missing component, so the unit of the system must bundle all five atomically — captured together, stored together, retrieved together.

**Design consequences.**

- The atomic record of the entire system is the **Context Moment**: screen frames + OCR text + UI semantics + audio/voice transcript + app/page metadata + timestamp + the user's intent utterance, as one structured record — never five separate artifacts to be joined later. Schema and lifecycle: [Context Engine](./CONTEXT_ENGINE.md), [Memory Engine](./MEMORY_ENGINE.md).
- Capture UX must acquire all five components in one gesture: invoke → frame + metadata captured → speak intent → done. A flow that captures pixels now and asks for intent later will collect intent approximately never.
- Retrieval must be able to query on any component: "what did I see about pricing," "what was I doing Tuesday during the meeting," "everything linked to the auth project."
- Cost we accept: Context Moments are heavier than screenshots — richer schema, an enrichment pipeline, more storage. We pay that; compression and expiration are the Context Engine's problem, not a reason to thin the unit.

## Principle 2 — Memory is context preserved with structure and retrievability; storage is not memory

**Statement.** Memory is not "we kept the bytes." Memory is context that remains *findable, meaningful, and correctable* over time. Real memory therefore implies three things storage does not: **forgetting, versioning, and consent.**

**Reasoning.** A camera roll stores everything and remembers nothing — retrieval probability per item decays toward zero as the pile grows ([Manifesto §1.2–1.3](./THE_CONTEXT_MANIFESTO.md)).

Human memory is useful *because* it is structured and lossy: it consolidates, links, prioritizes, and discards. A memory system that only accumulates becomes a liability twice over — a worse retrieval experience, and a growing breach surface of stale sensitive data.

And memory about a person that the person cannot inspect or veto is a dossier, not a memory.

**Design consequences.**

- The [Memory Engine](./MEMORY_ENGINE.md) is layered — working, session, project, relationship, semantic, visual, long-term — not a flat blob, because retrieval needs differ by layer and so do retention defaults.
- **Forgetting is a feature with an implementation**: expiration policies, decay/archival of unaccessed low-value moments, and user-initiated deletion that actually deletes — record, embeddings, media, graph edges — verified, not soft-flagged forever.
- **Versioning**: memory entries are corrected, not silently overwritten; the user can see what Nova believed and when. Wrong memory that can't be audited is worse than no memory.
- **Consent**: the user can inspect any memory, see its provenance (which Context Moment produced it), correct it, or delete it — surfaced in-product, not buried in a data-request process.
- Cost we accept: forgetting will occasionally delete something the user later wanted (mitigated by archive-before-delete windows), and versioning adds schema complexity. Both are cheaper than the alternative failure modes.

## Principle 3 — Intent is what separates Nova from a screenshot

**Statement.** Intent — the spoken or typed instruction attached to context at the moment of capture — is a mandatory component of the capture flow and the single highest-value bytes in the system. "Why this mattered, in the user's own words, at the moment it mattered."

**Reasoning.** Intent has the shortest half-life of any context component; days after capture it is unrecoverable by any means — no model can reconstruct *why you cared*.

It is also the component that makes everything downstream tractable: it disambiguates what part of the screen mattered, tells the Action Engine what to do, and gives the Memory Engine the connection hint ("...for the pricing deck").

A Context Moment without intent degrades into a smart screenshot. With intent, an eight-second capture carries a complete work order.

**Design consequences.**

- Capture UX is built around **push-to-talk intent**: invoke, speak one sentence, done. Voice, because it's the only input fast enough for the moment of discovery ([Why Now §4](./WHY_NOW.md)); typed input as the fallback; silent capture allowed but visibly marked as intent-less and gently discouraged.
- The raw utterance is stored verbatim alongside its transcript and the structured interpretation — interpretations can be wrong; the user's words are ground truth.
- Intent parsing (what to save, what to link, what action to create) is a first-class pipeline stage in the [Intelligence Engine](./INTELLIGENCE_ENGINE.md), and its output is *suggestions the user confirms* — project links, actions — per Principle 5.
- Cost we accept: an ASR dependency at the most latency-sensitive point of the product (MVP uses cloud ASR with disclosure, with a local whisper.cpp path via the companion service — [MVP Scope](./MVP_SCOPE.md)), and the awkwardness of speaking aloud in some settings, hence the typed fallback.

## Principle 4 — Action is the terminal value of context; unacted context is cost

**Statement.** Context exists to become action or insight: a task, a document, a decision made better, a question answered. Context that is captured and never used again is not an asset — it is storage cost, retrieval noise, and privacy surface. The system is judged on context *used*, not context *held*.

**Reasoning.** This is the graveyard-effect lesson ([Manifesto §2.3](./THE_CONTEXT_MANIFESTO.md)): read-later services proved that frictionless saving without a path to use produces guilt archives, not value.

It is also the honest metric discipline — a context platform that celebrates "moments captured" is measuring its own liability growth.

**Design consequences.**

- Every Instant Capture flows *toward* an action by default: the capture pipeline ends with a suggested action — task, project link, note, integration write ([Action Engine](./ACTION_ENGINE.md)) — which the user confirms, edits, or declines. Declining is fine; never being asked is not.
- North-star metrics are usage-side: moments retrieved, actions completed, questions answered from memory. Capture volume is a health input, never a success claim.
- Retention policy follows from this principle, not just from thrift: unused low-value context is a candidate for decay (Principle 2), because unacted context is cost.
- Cost we accept: pushing toward action adds a confirmation beat to capture UX. We keep it to one tap and make "just save it" a first-class outcome — the principle says context should *tend toward* action, not that every capture must spawn a task.

## Principle 5 — Human approval is a first-class primitive; the user is the root authority

**Statement.** Nova acts in the world on the user's behalf, and every action carries risk proportional to its blast radius. Approval is therefore an architectural primitive — typed, tiered, logged — not a confirm dialog bolted on. The risk tiers are canonical:

- **Tier 0 — auto-execute.** Internal and reversible: create a task in Nova, link a moment to a project.
- **Tier 1 — preview-then-confirm.** External writes: create a Notion page, a GitHub issue, a calendar event.
- **Tier 2 — explicit approval + audit trail.** Anything that sends data out of the user's control: messages to people, purchases, publishing, outbound webhooks with context payloads.

And above all tiers: **the user is the root authority over their context.** No assistant, integration, enterprise admin, or Nova itself outranks them on what is captured, retained, shared, or acted upon.

**Reasoning.** Two failure modes kill agentic products:

1. The agent that does damage autonomously — one bad Tier-2 action can end a user relationship or a company.
2. The agent that nags for approval on everything until the user stops reading the dialogs.

A tiered model is the only stable point between them — reversibility and blast radius, not convenience, decide the tier. Making approval a *typed primitive* (an approval object with a payload preview, scope, actor, and audit record) is what lets third-party clients on the Nova Developer Platform inherit the same safety envelope instead of reimplementing consent badly.

**Design consequences.**

- The [Action Engine](./ACTION_ENGINE.md) implements actions as proposals with a tier; Tier 1+ proposals render an exact preview of what will happen; Tier 2 additionally requires explicit approval and writes an immutable audit entry surfaced to the user in-product.
- API scopes mirror the tiers: `action:propose` is grantable to any client; `action:execute` is separately scoped and never bundled by default ([API & SDK Spec](./API_AND_SDK_SPEC.md)).
- Tier assignment is conservative by category, not negotiated per-request by a model — a model arguing itself into a lower tier is a failure case we design out.
- Root-authority consequences: export everything, delete everything (Principle 8); no admin override that silently widens capture on an employee's device without visible disclosure; no Nova-side access to user context except through user-granted, logged pathways.
- Cost we accept: friction on Tier 2, deliberately. Some slick autonomous demos are off the table. Good.

## Principle 6 — Infrastructure first; the app is a reference client

**Statement.** Nova is the context/memory/action substrate that assistants build on — Stripe for payments, Twilio for telephony, Plaid for financial data; **Nova for human context**. The Nova app exists to prove the substrate, drive early adoption, and keep the platform honest. The durable asset is the platform.

**Reasoning.** Users already live with multiple assistants, and every assistant vendor's memory is a silo whose incentive is lock-in ([Manifesto §3.3](./THE_CONTEXT_MANIFESTO.md)).

Context is more valuable than any single client because it outlives all of them — assistants will churn; a person's context accumulates for decades. The neutral position is also the only trustworthy one: an assistant vendor holding your context has a conflict of interest; a substrate whose customers are the user and the ecosystem does not.

The analogies are chosen precisely. Like payments and bank data, context is:

- needed by every application;
- miserable and sensitive to build well;
- better as one audited layer than as N half-baked silos.

**Design consequences.**

- Every capability ships API-first: the Nova app calls the same public APIs third parties get ([API & SDK Spec](./API_AND_SDK_SPEC.md)); no private fast paths, because private paths rot the platform.
- Schemas, scopes, and event formats are treated as contracts with deprecation discipline from v0 — even pre-code, the documents here define them as such.
- The [Business Model](./BUSINESS_MODEL.md) must never depend on the app winning as a destination product; platform revenue (metered API, OEM licensing) is the long-term center of gravity.
- Cost we accept: infrastructure is slower to show and harder to fund than a flashy app, and we deliberately empower assistants that could be seen as competitors. That's the position — the reference client gives us a consumer story while the substrate matures ([Roadmap](./ROADMAP.md)).

## Principle 7 — Local-first: perception happens on the device

**Statement.** Capture, buffering, and first-pass perception run on the user's device. The cloud is used for what genuinely requires it — heavy reasoning, embedding sync, cross-device continuity — always with data minimization, and users can pin projects to local-only processing.

**Reasoning.** Raw screen data is the most sensitive data stream a person can produce; the correct place to filter, redact, and minimize it is before it crosses the network, not after.

Local-first also buys latency (capture must feel instant), offline capture, and a credible enterprise/self-host story. It became a real architecture rather than a slogan only recently ([Why Now §2](./WHY_NOW.md)) — we take the gift.

**Design consequences.**

- The [Context Buffer](./CONTEXT_BUFFER.md) never leaves the device wholesale; only explicitly promoted Context Moments are processed further, and only their minimized form is uploaded.
- Clients carry real intelligence: local SQLite cache/queue, on-device filtering, local embeddings where trivial; the extension pairs with a local companion service for work the browser can't do ([System Architecture](./SYSTEM_ARCHITECTURE.md)).
- "Local-only project" is an enforced processing path — local models, no cloud calls — with the quality tradeoff disclosed to the user rather than hidden.
- Cost we accept: fatter clients, harder debugging, capability skew between local and cloud paths. Cheaper than betraying the data-flow promise.

## Principle 8 — The user owns their context: export everything, delete everything, monetize nothing

**Statement.** The user's context belongs to the user. Concretely:

- **Export everything** — full-fidelity export of everything Nova holds: structured data plus media, in documented formats.
- **Delete everything** — complete deletion on demand, verified, including derived artifacts: embeddings, memory entries, graph edges, backups per stated windows.
- **Monetize nothing** — context is never sold, never shared for advertising, never used to train models without explicit opt-in consent. Revenue comes from subscriptions and platform fees ([Business Model](./BUSINESS_MODEL.md)), full stop.

**Reasoning.** Partly ethics, mostly structural logic. The entire thesis requires users to route their most sensitive stream through Nova, and no one should do that — nor should we ask them to — under an advertising-shaped business model, where the incentive gradient bends toward exploitation regardless of founding intentions.

Ownership guarantees are also what make the infrastructure position tenable: a substrate that locks data in is just a bigger silo. Exit rights are what make staying a choice.

**Design consequences.**

- Export and deletion are product features with UI, not support tickets; deletion propagates through the enrichment pipeline's derived data by design ([Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md)).
- The revenue model is structurally incapable of data monetization — no ad systems, no data-sharing partnerships, no "anonymized insights" products. The prohibition is written into customer contracts so it binds us, including any future us.
- Cost we accept: we forgo real revenue lines competitors will take, and full export makes leaving easy. Both are the point.

## Principle 9 — Capture must be explicit; no covert observation, ever

**Statement.** Nova observes only when the user has explicitly invoked it, and observation is always visibly indicated and bounded:

- Instant Capture Mode captures on invocation, and only what the invocation reaches.
- Live Context Mode sessions are explicitly started, visibly indicated throughout, explicitly ended, and time-capped.
- The opt-in Context Buffer is short, local, and auto-purged.

There is no ambient mode, no silent capture, no dark pattern that extends observation beyond what the user knowingly chose.

**Reasoning.** Three independent lines converge here:

- **Ethics**: covert observation of a person's screen is surveillance, whoever's servers it stays on.
- **Platform policy**: app stores reject covert recording, and OS vendors are moving toward more visible capture indicators, not fewer — building on covert capture is building on sand ([Why Now](./WHY_NOW.md), "still not possible").
- **Law**: meeting audio intersects wiretap and all-party-consent statutes. Nova shows consent reminders in Live Context Mode when meeting audio is involved, and the user carries the consent responsibility — we say so plainly rather than pretending the problem away.

A product only some users would accept if they fully understood it is a product with a fraud in it. This one survives full understanding.

**Design consequences.**

- Every capture surface has a visible state indicator; Live Context sessions have a hard cap (30 minutes in MVP) and a hard stop; the buffer's existence, size, and purge behavior are user-visible settings ([Context Buffer](./CONTEXT_BUFFER.md)).
- We embrace, rather than route around, OS-level consent friction — macOS re-consent prompts, Android's persistent MediaProjection notification. Our UX treats these as features of the trust story.
- Cost we accept: we will lose "wow" comparisons against products that fake ambience or over-capture, and explicit invocation means we miss moments the user didn't think to capture. Both losses are cheaper than being the product that watched people.

## Principle 10 — Minimum context necessary

**Statement.** At every stage — capture, enrichment, storage, sharing, API access — Nova handles the least context that serves the user's stated purpose. Capture what the invocation asked for, not everything available; upload the minimized form, not the raw stream; grant integrations and API clients narrowly scoped, purpose-bound access, never a firehose.

**Reasoning.** Data minimization is the privacy principle that actually compounds: every byte not collected is a byte that can't leak, be subpoenaed, be misused by a future insider, or rot into liability.

It also improves the product — retrieval quality degrades with noise, and the Memory Engine's job gets harder with every irrelevant frame ingested. Holding less is both the safe posture and the smart one.

For an aspiring infrastructure layer, it is also the license to exist: the platform's clients must be structurally unable to over-read.

**Design consequences.**

- Scoped API permissions — `context:read`, `context:capture`, `memory:read`, `memory:write`, `action:propose`, `action:execute` — with per-project and per-layer granularity; no "all access" scope exists to be requested ([API & SDK Spec](./API_AND_SDK_SPEC.md)).
- Enrichment operates on excerpts and redacted forms where sufficient; raw media stays client-side-encrypted in object storage with access logged; observability explicitly excludes context payloads from logs ([System Architecture](./SYSTEM_ARCHITECTURE.md)).
- Retention defaults are finite and layer-appropriate; indefinite retention is a user choice, not the default (Principle 2).
- Cost we accept: minimization sometimes discards signal a future feature could have used, and scoped APIs are more work for integrators than a firehose. Correct on both counts.

---

## Anti-principles: positions we considered and rejected

Principles gain meaning from what they exclude. Each of the following was a live option at some point, is pursued seriously by someone else in the market, and is rejected here on the record — so that future proposals reintroducing them have to overturn the reasoning, not just outlast the memory of it.

**"Capture everything, sort it out later."**
The total-recall position: record the screen continuously and let search rescue you. Rejected because it fails Principles 9 and 10 outright, fails Principle 2 in practice (an ocean of unranked frames is storage, not memory), is unshippable under app-store policy, and collides with consent law the moment other people's words are on your screen. The Context Buffer — short, local, opt-in, purged — is the maximum ambient concession our principles allow, and it is enough: it covers "capture what I *just* saw," which is the actual user need behind most total-recall arguments.

**"The assistant is the product."**
Build the best assistant, let the memory be its moat. Rejected because it converts users' context into a retention hostage (the exact failure of the current vendor landscape — [Manifesto §2.5](./THE_CONTEXT_MANIFESTO.md)) and puts us in a capability war against the best-funded companies on earth, on their terms. Nova competes on the layer they structurally cannot build: the neutral one (Principle 6).

**"Monetize the data — tastefully."**
Anonymized insights, aggregate trends, ad signals with consent theater. Rejected without a carve-out. Every data business started with a tasteful version. Principle 8 exists precisely because incentive gradients beat founding intentions, so the gradient itself has to be removed: no ads, no data products, contractual prohibition. The cost (a smaller TAM for monetization) is accepted in exchange for the only asset this company actually requires: the user's justified trust.

**"Autonomy is the demo; approvals are friction to minimize."**
Rejected as a framing error. Approval friction on Tier 2 actions is not a UX debt to be paid down; it is the product behaving correctly (Principle 5). We minimize *unnecessary* approvals by tiering, never by letting the model self-assess its way downward.

**"Ship iOS-first because that's where the users are."**
Rejected on platform reality: iOS cannot host the core capture experience today ([Why Now](./WHY_NOW.md), "still not possible"). Shipping a gutted flagship first would define the product as a toy. The browser extension is where the full loop is legal, buildable, and honest — so it goes first, and iOS enters as a companion.

**"Build the graph database / vector store / agent framework we'll eventually need."**
Rejected as premature-infrastructure romanticism. Postgres + pgvector and relational entity/edge tables until scale forces otherwise ([System Architecture](./SYSTEM_ARCHITECTURE.md)). The novelty budget is spent on capture, memory semantics, and the approval primitive — not on rebuilding commodity layers with our logo on them.

## Using these principles

When principles collide — and they will (action-bias vs. approval friction, minimization vs. retrieval quality, infrastructure openness vs. safety) — the tiebreakers are, in order:

1. User authority (Principles 5, 8)
2. Explicitness and minimization (Principles 9, 10)
3. Memory integrity (Principle 2)
4. Action value (Principle 4)
5. Platform reach (Principle 6)
6. Everything else

A feature that grows the platform by weakening user authority is not a tradeoff to be weighed; it is out of scope by construction.

These ten principles are the constitution; [Product Vision](./PRODUCT_VISION.md) is what they build toward, [System Architecture](./SYSTEM_ARCHITECTURE.md) is what they build with, and [MVP Scope](./MVP_SCOPE.md) is their first falsifiable test.
