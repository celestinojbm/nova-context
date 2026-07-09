# Why Now

**Why this document.** "Why hasn't someone already built this?" is the correct first question about Nova Context, and it has a real answer: until recently, nobody *could* — not at consumer quality, not within platform rules, not at viable cost. This document walks through each enabling shift with a concrete 2021-vs-2026 comparison, then does the part most "why now" documents skip: an honest list of what is *still* not possible, because our roadmap and platform strategy depend on being right about both halves.

Related: [The Context Manifesto](./THE_CONTEXT_MANIFESTO.md) argues why the problem matters; this document argues why 2026 is when it became attackable. Platform constraints raised here are handled in depth in [System Architecture](./SYSTEM_ARCHITECTURE.md) and [Risks & Red Team](./RISKS_AND_RED_TEAM.md). Back to the [README](../README.md).

---

## The shape of the argument

Nova Context requires all of the following, simultaneously:

- machines that understand arbitrary screens;
- speech capture that is faster and more reliable than typing;
- memory that is searchable by meaning, cheaply, at personal scale;
- models cheap and fast enough to run on every single capture;
- a standard way for third-party assistants to consume external context;
- users who are culturally ready to talk to software about what's on their screen.

In 2021, roughly zero of these held at production quality. In 2026, all of them do. That is not incremental improvement — it is a set of *independent thresholds* that happened to be crossed within the same few years. Companies get built in exactly these windows.

| Requirement | 2021 | 2026 |
|---|---|---|
| Screen understanding | Research problem | API call with a per-image price |
| Spoken intent capture | Frustrating cloud dictation | Whisper-class, near human parity, local option |
| Semantic memory | Specialist infra (FAISS ops, weak models) | pgvector + commodity embeddings |
| On-device processing | Tiny task models only | whisper.cpp, quantized LLMs, NPUs standard |
| Assistant integration standard | None | MCP-era tool/context protocols |
| User readiness | Talking to AI was weird | Talking to AI is Tuesday |

A rough ordering of when each threshold was crossed:

- **late 2022** — Whisper releases; open, near-human ASR becomes a free commodity.
- **2023** — frontier multimodal models make arbitrary screenshots machine-legible; function calling standardizes tool use; pgvector adoption makes semantic search a Postgres feature.
- **2024** — quantized local models and NPU-standard hardware make on-device processing real; MCP-class protocols appear; screen-share-with-AI enters mainstream assistants.
- **2025–2026** — costs fall enough to run full understanding on *every* capture; multi-assistant fatigue becomes a mainstream, named complaint.

The last threshold is the quiet one that matters most: it moved "process everything the user captures" from a venture-subsidized stunt to a sustainable unit economic (see "The unit economics crossed zero" below).

The sections below take each shift in turn.

## 1. Multimodal LLMs: screens became legible

**2021.**

- No production model could look at an arbitrary UI screenshot and say what it meant. Vision-language research existed — CLIP matched images to captions, VQA models answered constrained questions — but nothing could take a screenshot of a Jira board, a YouTube frame with a slide on it, or a banking app and produce: what app this is, what the content says, which numbers matter, what the user is probably looking at.
- OCR (Tesseract-class) gave you unordered text fragments: no layout, no chart reading, no UI semantics, no salience.
- Building Nova in 2021 meant building frontier computer-vision research in-house before writing a line of product.

**2026.**

- Frontier models (Claude, GPT, Gemini families) read screenshots as a routine, boring capability: dense text, tables, charts, UI layout, handwriting, video frames, multi-image sequences.
- They answer questions like "what is the error in this stack trace," "what does this pricing table say for the enterprise tier," "which slide is this from the deck shown earlier."
- Screen understanding went from research problem to metered API call.

This is the single most important unlock: **perception → meaning became automatic**, which is the step whose manual cost killed every notes-app-shaped solution before it ([Manifesto §2.2](./THE_CONTEXT_MANIFESTO.md)).

Caveat we design around rather than wish away: screen understanding is very good, not perfect. Dense dashboards, ambiguous salience, and small text in compressed video frames still produce errors. See "Still not possible" below, and [Context Engine](./CONTEXT_ENGINE.md) for how we combine model vision with DOM and accessibility-tree structure instead of relying on pixels alone.

## 2. On-device AI: local-first became a real architecture, not a slogan

**2021.**

- "On-device AI" meant tiny task-specific models (keyboard prediction, face detection).
- Early NPUs existed in phones, but there was no practical way to run speech recognition, embeddings, or meaningful vision locally at useful quality.
- A privacy-respecting pipeline — process on device, send only the minimum — wasn't an engineering choice; it was unavailable.

**2026.**

- whisper.cpp runs high-quality speech recognition on a laptop CPU in real time.
- Small local models (1–8B parameters, quantized) handle classification, summarization, and redaction-grade tasks on consumer hardware.
- On-device embedding models are small, fast, and good enough for local search.
- Apple, Qualcomm, Intel, and AMD ship NPUs as default silicon, and OS vendors expose them to applications.

Consequence for Nova: the [Context Buffer](./CONTEXT_BUFFER.md) can be processed entirely locally, sensitive frames can be filtered or redacted before anything leaves the device, and "pin this project to local-only" is an implementable promise rather than marketing. Our local-first principle ([First Principles](./FIRST_PRINCIPLES.md), principle 7) is only credible because this shifted.

## 3. Capture and accessibility APIs matured — unevenly, and the unevenness is the strategy

**2021.**

- Desktop screen capture existed but through weak or deprecated sanctioned paths (macOS pre-ScreenCaptureKit was inefficient and half-blessed).
- Browser extensions were mid-transition into Manifest V3 chaos; capture APIs and service-worker lifetimes were moving targets.
- Android's MediaProjection and AccessibilityService existed, but policy enforcement around them was erratic and unpredictable.

**2026.** The map is legible and buildable, tier by tier:

- **Chromium extensions (MV3)** — `chrome.tabs.captureVisibleTab` for frames; `chrome.tabCapture` for tab video/audio with a user gesture; content scripts for DOM access, which yields *structured* page semantics richer than any OCR. Known limits: the extension only sees the browser, and MV3 service-worker lifetime requires careful design. This is why the [MVP](./MVP_SCOPE.md) starts here.
- **macOS** — ScreenCaptureKit plus the Accessibility API, both behind explicit user permission grants; macOS 15+ adds recurring re-consent and a persistent purple indicator during screen recording. Constraining, and good: it matches our explicit-capture principle exactly.
- **Windows** — Graphics.Capture and UI Automation, permissioned and supported.
- **Android** — AccessibilityService (view hierarchy, app awareness), MediaProjection (capture with a persistent notification), overlay permission for a floating button. Viable but heavy, and Play Store scrutiny of AccessibilityService use is real and can trigger rejection. We ship Android after desktop and extension for exactly this reason.
- **iOS** — matured the least, deliberately on Apple's part. See "Still not possible."

The strategic point: capture capability is now *tiered by platform*, and the tiers are stable enough to sequence a roadmap against. In 2021 the ground was still moving.

## 4. Voice crossed the usability threshold

**2021.**

- Pre-Whisper ASR (the original Whisper release came at the end of 2022) meant cloud dictation APIs that struggled with accents, jargon, and background noise.
- Latency and cost made "just say what you want" a frustrating interface.
- A decade of voice assistants had trained users to expect misunderstanding.

**2026.**

- Whisper-class and successor models transcribe accented, jargon-dense, noisy speech near human parity — in the cloud cheaply, or locally via whisper.cpp.
- Sub-second-ish transcription of a two-sentence utterance is routine.

This matters enormously because **intent capture is the product's soul**: the difference between Nova and a screenshot is the sentence the user says while capturing — "save this for the pricing deck and remind me Thursday." If speaking that sentence were slower or flakier than typing, Instant Capture Mode would die of friction. In 2021 it would have. In 2026, push-to-talk intent is the fastest input a human has.

## 5. Embeddings and vector search became commodity plumbing

**2021.**

- Semantic search meant running your own embedding models (SBERT-era quality) and operating FAISS or an early managed vector store.
- Specialist infrastructure, mediocre retrieval quality, and essentially no cross-modal capability.

**2026.**

- High-quality embedding APIs cost fractions of a cent per thousand items.
- Open local embedding models are good enough for on-device search.
- **pgvector turned vector search into a Postgres extension** — no separate database, transactional consistency with the system of record, boring operations.

Nova's memory substrate ([Memory Engine](./MEMORY_ENGINE.md)) is "Postgres + pgvector, dedicated vector DB only if scale demands" precisely because this layer is now a solved commodity rather than a bet.

## 6. Agent frameworks and tool-use standardized

**2021.**

- No function calling. Getting structured output from a model meant prompt hacks and regex.
- Getting a model to *use a tool* was a research demo; the early prompt-chaining libraries were still months from existing.
- An "assistant that consumes external context and takes actions" had no standard shape to conform to.

**2026.**

- Function calling / tool use is a first-class, schema-validated capability across every major provider.
- **MCP (Model Context Protocol)** and similar standards define how assistants discover and consume external context and tools.

This means "Nova as a context provider that any assistant can plug into" is not a proprietary integration fantasy; it is a conforming implementation of an emerging standard. This is the unlock for the infrastructure-first strategy specifically: in 2021 there was no socket for Nova to plug into. Now there is, and the number of sockets is multiplying. ([API & SDK Spec](./API_AND_SDK_SPEC.md) details how the Nova Developer Platform maps onto this.)

## 7. Capable open/local models and quantization

**2021.**

- GPT-3 was closed, API-only, text-only. Open alternatives were far behind.
- Any product needing model inference was locked to one or two vendors' pricing and policies — a fatal position for a privacy-sensitive infrastructure layer.

**2026.**

- Llama-class open models are genuinely capable; aggressive quantization (4-bit and below) costs modest quality for large footprint savings.
- Runtimes like Ollama make local inference a normal developer experience; self-hosted inference in private deployments is routine.

For Nova this enables: privacy-tier routing (sensitive content → local or self-hosted models), a credible enterprise self-host story, and genuine multi-provider leverage in the [Intelligence Engine](./INTELLIGENCE_ENGINE.md) instead of vendor hostage-ship.

## 8. Cloud orchestration got cheap and boring

The least dramatic shift, but it compounds:

- Serverless and small-footprint platforms (Fly.io/Railway-class) removed the ops tax for small teams.
- Managed queues and streams, cheap object storage with client-side-encryption patterns, WebSocket/SSE at scale.
- OpenTelemetry as default observability.

An event-driven ingestion pipeline — capture → queue → enrichment workers → storage — that would have needed a platform team in 2016 and a strong infra engineer in 2021 is now a well-trodden path a small team operates comfortably. Nova's backend ([System Architecture](./SYSTEM_ARCHITECTURE.md)) deliberately contains zero exotic infrastructure. The novelty budget is spent on capture and memory, not plumbing.

## 9. Users changed

Technology thresholds matter only if behavior meets them. Three behavioral shifts, all post-2022:

- **Talking to AI is normalized.** Hundreds of millions of people now converse with AI weekly. In 2021, speaking a sentence of intent at your computer was weird; in 2026 it's Tuesday.
- **Showing AI your screen is normalized.** Screenshot-to-chatbot is one of the most common AI workflows in existence, and screen-share-with-AI features have shipped in mainstream assistants. Users have already accepted the premise "AI can see what I see, when I choose." Nova's capture consent model builds on an established mental model instead of fighting for a new one.
- **Assistant fatigue created demand for a shared memory layer.** By 2026 a working professional touches several assistants — a chatbot, an IDE agent, a meeting notetaker, an email copilot — each with its own partial, siloed memory. The pain of re-explaining yourself to every assistant, and of knowing your context is scattered across vendors, is now *felt*, not hypothetical. In 2021 there weren't enough assistants for a substrate beneath them to make sense. Infrastructure demand follows application proliferation; the applications have proliferated.

## The unit economics crossed zero

The qualitative shifts above have a quantitative consequence worth stating on its own, because it decides whether the product can exist as a business: the marginal cost of *fully processing* one Context Moment.

What a single Instant Capture costs to process in 2026, order-of-magnitude:

- one or two vision-model calls on captured frames — fractions of a cent to a few cents, depending on model tier;
- five to fifteen seconds of ASR for the intent utterance — fractions of a cent in the cloud, ~zero locally via whisper.cpp;
- one embedding call over the extracted text — hundredths of a cent;
- entity extraction and linking on a small/cheap model — fractions of a cent;
- storage of the structured record plus compressed media — fractions of a cent per month.

Call it **single-digit cents per moment, worst case, on frontier models — and falling**, with the cheap majority of the pipeline movable on-device at zero marginal cost. In 2021, the honest number was "not computable at any price," because the vision step didn't exist; the nearest approximations (human transcription, brittle custom CV) were dollars per item and wrong.

Two design notes fall out of this arithmetic:

1. The cost structure supports a capped free tier and a flat Pro subscription without data monetization — the margin math works on subscriptions alone ([Business Model](./BUSINESS_MODEL.md)).
2. The expensive tail is *live sessions*, not captures — continuous frame sampling plus streaming ASR plus real-time answers. This is why Live Context Mode ships with a 30-minute cap and 1 fps sampling in the MVP: the bounds are cost honesty as much as privacy posture. The [Intelligence Engine](./INTELLIGENCE_ENGINE.md)'s routing-by-cost exists because these numbers, while workable, only stay workable if the cheap path is the default path.

## What is STILL not possible (and how we build anyway)

Credibility requires this list. These are not temporarily-hard problems; they are constraints that shape the architecture and roadmap, and two of them are outside our control entirely.

### 1. iOS system-wide observation

iOS does not allow any app to observe other apps' screens in general. Full stop.

What exists:

- share-sheet extensions (the user pushes content in);
- ReplayKit broadcast extensions (user-initiated full-screen broadcast — awkward UX, memory-capped around 50MB);
- Shortcuts / App Intents;
- screenshots via share; an in-app browser.

There is no workaround, and anyone claiming full Nova-on-iOS today is either violating policy or lying. Our position, stated plainly: **the iOS app is a companion** — capture via share sheet, voice notes, review and search of memory — and full Nova on iOS requires an Apple partnership or an OS-level change. That is a long-term bet, not a near-term plan. ([Risks & Red Team](./RISKS_AND_RED_TEAM.md) treats the downside; the [Roadmap](./ROADMAP.md) sequences accordingly.)

### 2. True always-on capture — and we wouldn't ship it if it were possible

Continuous full-screen recording plus understanding:

- busts battery and thermal budgets on mobile;
- would be rejected by both app stores as covert recording;
- collides with wiretap and all-party-consent laws the moment meeting audio is involved;
- fails our own ethics regardless of the above.

This is why the [Context Buffer](./CONTEXT_BUFFER.md) is what it is: opt-in, bounded (default 60s, max 5 minutes), local-only, visibly indicated, auto-purged. Products that bet on ambient total recall have repeatedly hit exactly this wall — technically, legally, and in public trust. The constraint is load-bearing in our design, not an apology.

### 3. Perfect UI understanding

Models misread dense screens, miss the element the user actually cared about, and hallucinate structure in ambiguous layouts. Error rates are low and falling, but not zero. Consequences we accept:

- capture always preserves the raw frame alongside the interpretation, so errors are recoverable;
- structured sources (DOM, accessibility trees) are preferred over pixels wherever available;
- anything downstream that *acts* on interpreted context passes through the risk-tiered approval model ([Action Engine](./ACTION_ENGINE.md)) — because acting confidently on a misread screen is worse than not acting.

### 4. Assorted honest residuals

- Real-time multimodal reasoning over long live sessions at consumer cost is still tight — hence Live Context Mode's 30-minute session cap and 1 fps frame sampling in the [MVP](./MVP_SCOPE.md).
- Fully-local frontier-quality reasoning on average hardware isn't here — hence cloud reasoning with data minimization rather than local-everything.
- Cross-app semantic understanding on platforms without accessibility-tree access degrades to OCR quality, and we say so rather than pretending otherwise.

## The window

Every enabling shift above is available to everyone — OS vendors, assistant vendors, well-funded startups — so "possible now" cuts both ways. Our claim is narrower than "we're first":

1. A *neutral, user-owned* context layer is a position none of the incumbents can credibly occupy. Their incentive is the silo, and their memory features prove it.
2. The standards moment (MCP-era) is precisely when a neutral layer can plug in everywhere at once.
3. Honest handling of the constraints above — especially iOS and always-on — is itself a moat, because the shortcuts competitors might take are exactly the ones that get products banned and trust destroyed.

The competitive analysis continues in [Risks & Red Team](./RISKS_AND_RED_TEAM.md); what we do with the window starts in [MVP Scope](./MVP_SCOPE.md).
