# MVP Scope

**Why this document exists.** Ambition is cheap; scope discipline is what ships. Nova Context is a large idea — a universal context substrate for every assistant — and the fastest way to kill it is to try to build all of it. This document draws a hard line around the smallest thing that can *falsify or validate the core theses*, states exactly what is in and out, and commits to numeric kill/pivot criteria so we find out whether this works before we spend a year finding out.

Read this with [RISKS_AND_RED_TEAM.md](./RISKS_AND_RED_TEAM.md) (why the scope is defensively narrow) and [BUILD_PLAN.md](./BUILD_PLAN.md) (how these features get built, milestone by milestone). Architecture terms used here are defined in [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md).

The MVP is: a **Chromium browser extension (MV3) + a minimal cloud backend + a Next.js web app + one integration (Notion) + Nova's own task list.** Single user, English-first. That's it.

---

## 1. The two theses as testable hypotheses

The MVP exists to test two hypotheses. Each has explicit success criteria. If we cannot hit them, the product as conceived does not work and we pivot or kill (§9).

### Thesis 1 — Instant Capture is worth the friction

> **Hypothesis:** Users will deliberately invoke Nova to capture context, and the capture→link→action loop is fast and useful enough to become a repeated habit.

**Success criteria (all three must hold in the alpha):**

| Metric | Target | Why it's the right bar |
|--------|--------|------------------------|
| Time from invocation to a linked, actioned Context Moment | **< 30s median** | Friction is our core product risk ([RISKS §10](./RISKS_AND_RED_TEAM.md)). Above 30s the deliberate act decays. |
| Share of captures that produce a **kept** action (not deleted/ignored within 7 days) | **> 60%** | Measures whether captures are *useful*, not just performed. A capture that produces junk actions trains users to stop. |
| Weekly return rate (distinct days a user invokes Nova) | **> 3× / week** | Habit formation. A tool used <3×/week is a bookmark, not infrastructure. |

### Thesis 2 — Live Context is real-time-useful

> **Hypothesis:** During an ongoing activity on a browser tab, Nova can answer questions grounded in a short rolling buffer well enough to be trusted, and users will save the insights.

**Success criteria:**

| Metric | Target | Why it's the right bar |
|--------|--------|------------------------|
| User-rated **groundedness** of live answers (answer reflects what was actually on screen, thumbs-up/down per answer) | **> 80% positive** | If live answers hallucinate or drift from the buffer, the mode is worse than useless — it's misleading. 80% is the floor for trust. |
| Share of live sessions that produce ≥1 **saved** Context Moment | **> 40%** | Measures whether the live insight is worth keeping, i.e. whether Live Mode feeds the memory graph or is just ephemeral Q&A. |
| Median live-answer latency | **< 4s** | "Real-time" has a felt ceiling; beyond a few seconds users stop asking. |

Thesis 1 is the primary bet. Thesis 2 is the secondary bet and is the **first thing cut** if we are behind (§8) — it is scoped to a *browser tab's own audio/video*, not multi-party meetings, to avoid the wiretap/consent surface ([RISKS §6, §8](./RISKS_AND_RED_TEAM.md)).

---

## 2. Exact MVP surface

Five components, no more:

1. **Chromium extension (MV3)** — capture, invocation, push-to-talk voice, side-panel UI. Chrome + Edge (Chromium). Not Firefox, not Safari.
2. **Minimal cloud backend** — Fastify (Node 22) ingestion + query API, Postgres 16 + pgvector (system of record + embeddings), Redis + BullMQ (enrichment queue + workers). No microservices — a monolith API plus a worker process.
3. **Next.js web app** — memory timeline, project detail, action approvals, settings.
4. **One integration: Notion** — Tier-1 (preview-then-confirm) action target. Exactly one external integration.
5. **Nova's own task list** — Tier-0 (auto, internal, reversible) action target, so the product is useful with zero external integrations connected.

There is no desktop app, no mobile app, no public API, no marketplace in the MVP. (§6)

---

## 3. In-scope features per mode

Numbered and testable. If a feature can't be demoed and measured, it isn't in scope.

### Instant Capture Mode

1. **Invoke via keyboard shortcut or toolbar/side-panel button** in a Chromium tab. Sub-second, no app switch.
2. **Capture the visible tab** via `chrome.tabs.captureVisibleTab` (a frame) **plus DOM extraction** via a content script (title, URL, selected text, main article text, key metadata) — DOM text is richer and cheaper than OCR and is the primary text source.
3. **Push-to-talk spoken instruction** captured in the side panel via `MediaRecorder`, transcribed by a Whisper-class cloud ASR (with in-UI disclosure that audio goes to the cloud). **Typed input is always available** as a fallback and equal-class citizen.
4. **Normalize into a Context Moment draft** — frame + extracted text + page metadata + timestamp + the user's intent utterance — shown to the user before submit.
5. **Submit** `POST /v1/context/moments`; enrichment runs async in a worker: summary, entity extraction, embedding, project suggestion.
6. **Auto-suggest project link** — top-3 candidate projects by embedding similarity + recency, with confidence scores; **user confirms or overrides**; every override is logged as a training signal.
7. **Create an action** from the parsed intent: **Tier-0 Nova task** (auto) and/or **Tier-1 Notion page** (preview-then-confirm card). Result is linked back to the Context Moment.
8. **The Moment appears in the web-app timeline** immediately, enrichment fields filling in as the worker completes.

### Live Context Mode

9. **Start a bounded live session on the current tab** via `chrome.tabCapture`, with an explicit visible indicator and a **hard 30-minute cap**.
10. **Rolling 60s Context Buffer** — 1 fps frame sampling + tab audio transcript, held in an offscreen document's ring buffer (RAM/temp only, never uploaded wholesale, auto-purged on session end).
11. **Ask questions via push-to-talk** during the session; **answers are grounded in the buffer** and cite what was on screen; latency target <4s.
12. **"Save this"** promotes the current buffer window into a persistent Context Moment (same enrichment path as Instant Capture).
13. **Explicit end** (button or cap) tears down capture, purges the buffer, and shows a session summary the user can save.

### Cross-cutting (both modes)

14. **Memory timeline** in the web app — reverse-chronological Context Moments with **hybrid search** (keyword + vector).
15. **Project view** — a project's linked moments, actions, and entities.
16. **Action approvals** — a queue for Tier-1 actions awaiting confirm; Tier-0 shown as completed.
17. **Settings** — Notion connection, ASR/cloud disclosure + toggle, data export, deletion, per-project local-only note.
18. **In-product audit log** — every capture, action, and integration call, user-readable.

---

## 4. Platform honesty table

What is actually possible, on which platform, right now. This is not aspirational — it is what the APIs permit. (Full treatment in [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md) and [RISKS_AND_RED_TEAM.md](./RISKS_AND_RED_TEAM.md).)

| Capability | Status | Detail |
|------------|--------|--------|
| **Chromium extension: visible-tab capture** (`captureVisibleTab`) | ✅ Buildable NOW — **in MVP** | Single-frame capture of the active tab on user gesture. |
| **Chromium extension: tab video/audio** (`tabCapture`) | ✅ Buildable NOW — **in MVP** | Powers Live Context Mode buffer; requires user gesture. |
| **Chromium extension: DOM extraction** | ✅ Buildable NOW — **in MVP** | Content script; richer than OCR; primary text source. |
| **Chromium extension: push-to-talk mic** (`MediaRecorder`) | ✅ Buildable NOW — **in MVP** | Voice instruction; cloud ASR with disclosure. |
| **Desktop full-screen capture** (macOS ScreenCaptureKit / Windows Graphics.Capture, Tauri v2) | ✅ Possible NOW — **deferred to post-MVP** | Works, needs OS permission grants (macOS recurring purple indicator). Deferred to keep MVP to one platform. |
| **Android capture** (AccessibilityService + MediaProjection + overlay) | ⚠️ Possible but **policy-risky — deferred** | MediaProjection forces persistent notification; AccessibilityService-as-data-pipe risks Play Store rejection. Not in MVP. |
| **Local processing** (on-device OCR/DOM, local embeddings) | ◑ Partial in MVP | DOM extraction and frame handling are client-side; heavy reasoning + embedding sync are cloud in MVP; local embeddings only if trivial. |
| **iOS: system-wide screen observation** | ❌ Impossible today | No public API. Sandbox forbids one app watching another. Requires Apple partnership/OS change. |
| **iOS: ReplayKit full-screen capture** | ❌ Not viable | Broadcast extension ~50MB memory cap OOMs any vision workload; awkward system picker + red bar every session. |
| **iOS: share-sheet companion** | ◑ Possible — **not in MVP, future companion** | User pushes content *in*; voice notes; review/search memory. Companion only, not an observer. |
| **True ambient / always-on capture** | ❌ Dropped | Not built on any platform (Recall precedent, ethics, policy). |
| **Cross-app iOS context / OS-level invocation** | ❌ Requires future OS partnership | 10-year goal, not a product claim. |
| **Wake-word invocation** | ❌ Out of scope | Deferred; push-to-talk only in MVP. |

---

## 5. Out of scope (explicit, with one-line reasons)

Each of these is a real thing people will ask for. Each is deliberately excluded from the MVP.

| Excluded | One-line reason |
|----------|-----------------|
| Mobile apps (iOS/Android) | Three-front platform risk; iOS impossible, Android policy-risky — one platform at a time ([RISKS §1, §2, §9](./RISKS_AND_RED_TEAM.md)). |
| Desktop app (Tauri) | Possible but a second platform; MVP proves the thesis on the browser first. |
| Wake-word / voice-activation | Always-listening mic is a trust and battery problem; push-to-talk only. |
| Multiple integrations | One integration (Notion) tests the action loop; more is surface area without new learning. |
| Marketplace / plugins | Platform play requires the graph to exist first; deferred to 12-months+. |
| Public API for third parties | Same — API needs the consumer product to earn the data first ([RISKS §9](./RISKS_AND_RED_TEAM.md)). |
| Multi-model consensus routing | Single primary model + one fallback is enough; consensus is cost with no MVP payoff. |
| Knowledge-graph UI | Entities/edges stored relationally; a graph *visualization* is polish, not thesis-testing. |
| Team / collaboration features | Single-user first; multi-user auth/sharing is a different product. |
| End-to-end encryption | Client-side media encryption yes; full E2EE breaks server-side enrichment — deferred. |
| Local LLM inference | Cloud reasoning with disclosure for MVP; local embeddings only if trivial. |
| Non-Chromium browsers (Firefox/Safari) | Different extension APIs; port after the model is proven. |
| Non-English | ASR + enrichment tuned English-first; i18n is post-validation work. |

---

## 6. Cut lines (ordered) if behind schedule

If we are behind, we cut in this exact order — from least to most damaging to the core thesis. We cut *before* we slip the alpha date.

1. **Live Mode audio transcript** — keep live visual buffer + Q&A over frames; drop tab-audio ASR. (Removes the ASR-in-live-loop complexity and part of the consent surface.)
2. **Live Context Mode entirely** — ship Instant Capture only. Thesis 1 is the primary bet; Thesis 2 can be validated in a later cycle.
3. **Notion integration** — ship with only Nova's own task list (Tier-0). The capture→link→action loop still works end-to-end; only the external Tier-1 target is gone.
4. **Auto-suggest project linking → manual** — user picks the project from a list instead of getting ranked suggestions. The linking step survives; only the ML-assisted suggestion is deferred.

Note the invariant: the **capture → Context Moment → project link → action → visible in timeline** loop is never cut. That loop *is* Thesis 1. Everything above is scaffolding around it.

---

## 7. What "done" means for the MVP

The MVP is done when a single English-speaking user can, in a Chromium browser:

- Invoke Nova, capture a tab with a spoken instruction, get it linked to the right project and turned into a kept action, in <30s median — repeatedly, across days.
- Start a bounded live session on a video/tab, ask grounded questions, and save an insight.
- See all of it in a searchable timeline, review/approve Tier-1 actions, connect Notion, and export or delete everything.
- Do all of the above with the minimal permission set, capture-time redaction, encryption, and audit log from [RISKS §7, §8, §13](./RISKS_AND_RED_TEAM.md) in place.

Engineering-level definition of done and the north-star demo sentence live in [BUILD_PLAN.md](./BUILD_PLAN.md).

---

## 8. (see §6) — cut lines are the schedule-risk valve

*(Section intentionally merged into §6 above; retained here as a pointer so milestone docs referencing "the cut lines" resolve.)*

---

## 9. Alpha plan

**Cohort.** ~25 users, hand-picked, high-context knowledge workers (developers, researchers, PMs) who live in the browser and already use Notion — the population most likely to feel the pain Nova addresses and least likely to be confused by an early tool.

**Instrumentation — the funnel.** Every user is instrumented through the core loop:

```
invoke → capture → (project) link → action → return
```

We measure, per user and in aggregate:
- **Invoke → capture** completion rate and time.
- **Capture → link** rate (and suggestion-accept vs. override rate — the override log is a training signal).
- **Link → action** rate and Tier-0 vs Tier-1 split.
- **Kept-action rate** at 7 days (actions not deleted/ignored).
- **Return rate** — distinct active days per week per user.
- **Time-to-action** distribution (median, p90).
- **Live Mode:** session count, groundedness thumbs, saved-moment rate, latency.

**Qualitative.** Weekly 30-minute interviews with a rotating subset (aim: every user interviewed at least twice over the alpha). We're listening for: *did you reach for it without being reminded?*, *did the action save you real work?*, *what did you expect it to do that it didn't?*

**Duration.** 6 weeks of active use after M4 deploy (see [BUILD_PLAN.md](./BUILD_PLAN.md)), following a 2-week onboarding ramp.

**Kill / pivot criteria (numeric, decided in advance):**

| Signal | Kill/pivot threshold | Action |
|--------|----------------------|--------|
| Median time-to-action | > 45s sustained | Pivot: the loop is too slow to habituate — rethink invocation/UX before anything else. |
| Kept-action rate | < 40% | Pivot: captures produce junk — the intelligence/linking is wrong, not the concept. |
| Weekly return rate | < 1.5×/week median after ramp | **Kill signal for Thesis 1** — the vitamin never became a habit. Reassess whether ambient (impossible now) is the only viable form. |
| Live-mode groundedness | < 60% positive | Cut Live Mode (it's misleading), refocus on Instant Capture. |
| Net: ≥2 of the three Thesis-1 targets missed after full alpha | — | Do not scale. Pivot the wedge (assistant-integration first, per [RISKS §9, §13](./RISKS_AND_RED_TEAM.md)) or stop. |

**Success trigger.** All three Thesis-1 targets met (or clearly trending to met) → proceed to the 6-month roadmap: desktop (Tauri) with full-screen capture, project intelligence, public beta, and API v0 for 2–3 design partners.

The alpha is explicitly a **falsification test**, not a launch. We are trying to disprove the compounding-memory thesis cheaply. If it survives 25 skeptical power users for 6 weeks, we have earned the right to build the rest.
