# The Context Manifesto

**Why this document.** Every other document in this repository assumes a claim that deserves to be argued, not assumed: that human digital context is becoming one of the most important resources of the AI era, that today's tools systematically destroy it, and that preserving it is an infrastructure problem. This document makes that argument. If you disagree with it, the rest of the repo is elaborate machinery for a problem you don't believe in — so start here.

Related: [First Principles](./FIRST_PRINCIPLES.md) turns this argument into design commitments; [Why Now](./WHY_NOW.md) explains why the argument only recently became actionable; [Theory of Human Digital Context](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md) formalizes the model sketched here. Back to the [README](../README.md).

---

## 1. The problem, concretely

### 1.1 The moment-of-discovery problem

Value on screens arrives at the worst possible time: while you are doing something else.

- You are watching a conference talk and the speaker flashes an architecture slide for eight seconds.
- You are scrolling a feed and someone links the exact benchmark you needed for a decision you're making next week.
- You are in a video call and a colleague shares a spreadsheet cell that contradicts your plan.
- You are reading documentation and notice a config flag that would fix a bug in a *different* project.

In every case, the information is:

- **Fast** — it appears without warning and often without a stable URL.
- **Ephemeral** — the slide advances, the feed scrolls, the screen share ends, the story expires.
- **Mid-flow** — you are busy. Stopping to capture properly means losing your place in the thing you were actually doing.

So the realistic options are: do nothing (most common), or grab a screenshot or bookmark in under two seconds and hope your future self can reconstruct why.

The moment of noticing — the single point in time when you know *exactly* what this information is, why it matters, and what should happen next — is precisely the moment no tool is built to serve. Two weeks later, that knowledge is gone even if the pixels survive.

This is the moment-of-discovery problem: **the value of information peaks at the instant of noticing, and our capture tools operate at their worst at exactly that instant.**

### 1.2 Context decay

Suppose you do capture something. What you captured starts rotting immediately, along several independent axes:

| Axis | What decays | Half-life |
|---|---|---|
| Intent | Why you saved it, what you meant to do | Days. Often hours. |
| Connection | Which project/decision/person it related to | Days to weeks. |
| Meaning | What the content actually says (a chart with no caption, a snippet with no source) | Weeks. |
| Referent | Whether the underlying thing still exists (link rot, edited posts, expired shares) | Months, unbounded downside. |
| Findability | Whether you can locate it among thousands of siblings | Degrades with every new capture. |

Note what decays fastest: intent and connection — the parts no existing tool records at all. The pixels of a screenshot are immortal; the reason for the screenshot dies first.

A camera roll with 4,000 screenshots is not a memory. It is a landfill with excellent image fidelity.

### 1.3 Fragmentation

The third failure is spatial rather than temporal. A single working day scatters context across:

- browser history and a screenshots folder;
- three notes apps and a bookmarks bar;
- "saved" tabs inside four different social platforms;
- Slack saved-items, email starred-items, a read-later queue;
- meeting recordings; and the memory features of two or three different AI assistants.

Each silo has its own search (usually bad), its own retention rules, and no knowledge of the others. The question you actually have — *"what was that thing I saw about X, around the time I was working on Y?"* — spans all of them and is answerable by none of them.

Fragmentation isn't an inconvenience; it's a structural guarantee that connection (the link between a piece of context and the rest of your work) can never form, because no single system holds both ends of the link.

## 2. Why every existing tool class fails

Each of the following tools is genuinely useful, has enormous adoption, and fails the moment-of-discovery problem in a specific, structural way. The failures are not implementation bugs to be fixed by a better version of the same tool; they are consequences of what each tool fundamentally is.

### 2.1 Screenshots: pixels without meaning, intent, or connection

The screenshot is the honest baseline — it's what people actually do, billions of times a day, because it's the only capture that fits inside two seconds. And it preserves exactly one of the five things that matter: perception. Pixels.

- No **meaning**: the text in the image is not text. OS-level OCR is partial and unstructured, and it doesn't understand what the app was, what the chart said, or which part mattered.
- No **intent**: nothing records *why*. A screenshot of a flight price and a screenshot of a bug report look identical to every system that will ever store them.
- No **connection**: it lands in a camera roll sorted by time, adjacent to memes, unrelated to the project it was for.
- Weak **time**: a timestamp exists, but not the situation — what you were doing, what tab was active, what was said.

Screenshots fail not because they capture too little but because they capture the *wrong layer*: the display buffer instead of the situation.

### 2.2 Notes apps: the manual transcription tax

Notes apps preserve meaning and intent — if you type them in. That "if" is the whole failure.

A good note about a discovered piece of context takes 60–180 seconds of transcription and structuring: what it was, where it was, why it matters, what to do. That cost is paid at exactly the moment you don't have it (see 1.1). So in practice people write either nothing, or a five-word fragment ("check this later — auth thing??") that fails the same way a screenshot does.

Notes apps are excellent tools for *deliberate authorship*. Discovery is not authorship. Asking a human to be a real-time court stenographer of their own attention is the design error, and no amount of better editors, backlinks, or sync fixes it.

### 2.3 Bookmarks and read-later: the graveyard effect

Bookmarks capture a pointer, not the thing. Structural failures:

- **Links rot.** The page changes, the post is deleted, the paywall descends, the share link expires. You saved an address to a building that got demolished.
- **No sub-page resolution.** You needed one paragraph, one chart, one timestamp in a 90-minute video. The bookmark stores the front door.
- **No intent.** A folder named "Read later" is an intent black hole. Why did you save it? For which project? What were you going to do?
- **The graveyard effect.** Because saving is free and retrieval is unassisted, save-count grows monotonically while retrieval probability per item drops toward zero. Every read-later service's own engagement data tells the same story: saving is the product; reading rarely happens. The archive becomes a place where intentions go to be forgotten guilt-free.

### 2.4 Search engines: public recall, not personal recall

Search solved recall for the public web and deserves the credit. But it answers "what does the internet know about X?" — never "what did *I* see about X, and why did it matter to *me*?"

Your meeting screen-shares, your chats, the slide that was on screen for eight seconds, the price you saw before it changed: none of it was ever indexed, because it was never public, never stable, and never crawlable. Personal context is by construction outside the corpus.

A better ranking algorithm cannot fix an empty index.

### 2.5 Current AI assistants: brilliant, amnesiac, blind, and siloed

The 2023–2026 assistant wave got reasoning; it did not get context. Three structural gaps:

- **Session amnesia.** Vendor "memory" features are shallow (a list of extracted facts, not layered structured memory), opaque (you can't meaningfully inspect or correct most of it), and forgetful in ways you don't control. Long-context windows help within a session; the session still ends.
- **Perceptual blindness.** The assistant cannot see your screen unless you laboriously feed it. The dominant workflow — screenshot, switch apps, upload, retype your question, lose your flow — is the moment-of-discovery problem with extra steps.
- **Silos.** Whatever memory an assistant does build is locked to that vendor. Your context in ChatGPT is invisible to Claude, to Copilot, to the agent your company deploys next year. Switching assistants means amnesia by design. Memory as a retention moat is good for vendors and bad for users — and it guarantees that no single assistant will ever hold your whole context, because you use more than one.

### 2.6 Automation tools: triggers without noticing

Zapier, Shortcuts, IFTTT, workflow builders: they act, which is more than any tool above. But they trigger on **structured machine events** — a row added, an email received, a webhook fired.

The event that matters in our problem is *"a human noticed something significant on a screen."* It is unstructured, unpredictable, and defined only by human attention and intent in that moment. No trigger schema can express it, because the trigger is a judgment call only the human can make, and the payload is whatever happened to be on screen.

Automation tools start where context capture ends; they cannot start it.

### 2.7 The pattern

Line the failures up and they're the same failure:

| Tool | Perception | Meaning | Intent | Connection | Time | Action |
|---|---|---|---|---|---|---|
| Screenshot | ✅ pixels | ❌ | ❌ | ❌ | partial | ❌ |
| Notes app | ❌ | ✅ if typed | ✅ if typed | manual | manual | ❌ |
| Bookmark / read-later | pointer only | ❌ | ❌ | folder at best | save-date | ❌ |
| Search engine | ❌ (public only) | ✅ public | ❌ | ❌ | ❌ | ❌ |
| AI assistant | ❌ (can't see) | ✅ in-session | ✅ in-session | ❌ siloed | ❌ amnesia | partial |
| Automation | ❌ | ❌ | prewritten rules | ❌ | ❌ | ✅ structured |

Every tool captures a fragment. No tool captures the situation. And the fragments don't compose, because they live in different silos with no shared spine.

## 3. The thesis

### 3.1 Context is five things, together

**Context = perception + meaning + intent + connection + time.**

- **Perception** — what was actually on screen and in the air: frames, text, UI structure, audio.
- **Meaning** — what it says: entities, claims, numbers, the semantic content a machine can reason over.
- **Intent** — why the human cared *right then*, in their own words: "save this for the pricing deck," "remind me when I'm back on the auth bug," "compare this to what Sarah sent."
- **Connection** — what it attaches to: which project, which decision, which person, which prior moment.
- **Time** — not just a timestamp, but the situation: what was active, what was ongoing, what came just before.

Drop any one component and value collapses to one of the failed tool classes above. This is why "a better screenshot tool" or "a smarter notes app" cannot solve the problem — the unit of capture itself is wrong.

The correct atomic unit is what we call a **Context Moment**: screen frames + OCR text + UI semantics + audio/voice transcript + app/page metadata + timestamp + the user's spoken intent, stored as one structured record. (Formal treatment in [Theory of Human Digital Context](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md).)

### 3.2 AI makes all five preservable for the first time

Until roughly the mid-2020s, capturing all five components required a human to do the work of three of them — meaning, intent-transcription, connection — by hand. That is exactly the tax that made notes apps fail. What changed:

- Multimodal models can now read an arbitrary screenshot the way a person does — layout, charts, UI state, what's salient — turning **perception into meaning** automatically.
- Whisper-class speech recognition made spoken intent capture effectively free: two seconds of talking replaces two minutes of typing. **Intent** can now be captured at the speed of noticing.
- Commodity embeddings and cheap retrieval make **connection** computable: a new moment can be linked to the projects, people, and prior moments it resembles, with the user confirming rather than filing.
- All of it can run in a pipeline fast and cheap enough to happen at capture time, not as a someday-batch job.

The full before/after argument, including what is still *not* possible, is in [Why Now](./WHY_NOW.md). The short version: the moment-of-discovery problem is ancient; the ability to solve it without human transcription labor is roughly three years old.

### 3.3 Whoever holds context becomes infrastructure

The last piece of the thesis is structural, not technical.

Assistants are converging in raw capability; models are increasingly interchangeable. What is *not* interchangeable is context: an assistant that knows what you've seen, what you're working on, and what you meant is categorically more useful than an identical model that doesn't. Context is becoming the differentiating input to every AI system a person touches.

That creates a fork in the road:

1. **Every assistant vendor builds its own capture-and-memory silo.** Users get amnesia at every vendor boundary, re-teach every new assistant from zero, and their most sensitive data is held as a retention hostage by whichever vendor got there first.
2. **Context becomes a neutral layer the user owns**, with assistants as interchangeable clients on top — the way payments (Stripe), telephony (Twilio), and bank data (Plaid) became neutral layers under thousands of applications.

We are building for the second outcome. Nova Context is that layer: capture and perception at the edges, structured memory in the middle, actions and an API on top, with the user — not any assistant vendor, and not us — as the root authority over what's in it.

The app we ship is a reference client that proves the layer works; the layer is the point. ([First Principles](./FIRST_PRINCIPLES.md), principle 6, takes up why infrastructure-first; [Product Vision](./PRODUCT_VISION.md) describes what it becomes.)

This position carries obligations, and we accept them as constraints rather than aspirations:

- capture must be explicit and visible, never covert;
- the user can export everything and delete everything;
- the data is never monetized;
- actions taken on the user's behalf are risk-tiered, with human approval as a first-class primitive.

Infrastructure for human context that is not trustworthy is not infrastructure — it's surveillance with an API. The commitments are specified in [First Principles](./FIRST_PRINCIPLES.md) and enforced in [Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md).

## 4. Objections we take seriously

A manifesto that cannot state its best counterarguments is advertising. These are the four strongest objections we know, with our actual answers. (The full adversarial treatment is in [Risks & Red Team](./RISKS_AND_RED_TEAM.md).)

**"People don't actually capture things; behavior won't change."**

Partially true, and it's why the bar is so specific: capture must cost *less than a screenshot* — the one capture behavior billions of people already exhibit — while preserving more than a note. We are not trying to create a new behavior; we are trying to upgrade the payload of an existing reflex. If Instant Capture Mode takes longer than a screenshot in practice, the thesis fails on contact, which is exactly what the [MVP](./MVP_SCOPE.md) is scoped to find out with real users.

**"OS vendors will just build this."**

They will build *parts* of it — capture and on-device recall are natural OS features. What an OS vendor structurally will not build is the neutral, cross-platform, cross-assistant layer: Apple will not ship your context to Gemini, Google will not ship it to Claude, and neither will hand the user a full-fidelity export to take elsewhere. The OS vendors' entry validates the category and forecloses only the siloed version of it. Our exposure is real (an OS could restrict the APIs we need) and is treated as a first-order risk, not a footnote.

**"This is a privacy nightmare wearing a privacy costume."**

It would be, built carelessly — which is why the constraints are structural rather than promissory: explicit invocation only, visible indication, a bounded local buffer, minimized uploads, export/delete rights, no data monetization written into contracts, and approval tiers on anything that sends data outward. We'd rather lose features than lose this argument; several deliberately missing features (no ambient mode, no silent capture) *are* the answer to this objection.

**"The unit economics of running models on every capture don't work."**

They didn't in 2021; they do now, and the curve has a direction. A capture involves one or two frame-understanding calls, seconds of ASR, and an embedding — all commodity-priced and falling, with local paths for the cheap majority of the work ([Why Now](./WHY_NOW.md)). The expensive tail (long live sessions) is bounded by design: session caps and sampling rates exist partly for cost honesty.

## 5. What follows

If this argument holds, three things follow, and the rest of the repository is organized around them:

1. **The unit of the system is the Context Moment**, not the file, the link, or the chat message — see [Theory of Human Digital Context](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md) and [Context Engine](./CONTEXT_ENGINE.md).
2. **Capture must cost less than a screenshot and preserve more than a note** — the two product modes (Instant Capture Mode, Live Context Mode) are designed against that bar; see [Product Vision](./PRODUCT_VISION.md) and [Context Buffer](./CONTEXT_BUFFER.md).
3. **The system must be built as a platform from day one**, even though it ships as an app first — see [System Architecture](./SYSTEM_ARCHITECTURE.md) and [API & SDK Spec](./API_AND_SDK_SPEC.md).

We hold this thesis with confidence and test it cheaply: the [MVP](./MVP_SCOPE.md) is deliberately small — one browser, one integration, two modes — because a thesis this large deserves a falsifiable first experiment, not a leap of faith. The known ways we could be wrong are catalogued honestly in [Risks & Red Team](./RISKS_AND_RED_TEAM.md).

Context is the memory of a working life. Right now it evaporates by default. We think that's a solvable infrastructure problem — and one of the most consequential ones of the decade.
