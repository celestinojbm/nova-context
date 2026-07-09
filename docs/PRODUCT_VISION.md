# Product Vision

**Why this document.** This is Nova Context from the user's seat: what they touch, what they see, what happens in the seconds after they invoke it. The theory of what we capture lives in [THEORY_OF_HUMAN_DIGITAL_CONTEXT.md](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md); the machinery lives in the engine docs. This document is the contract for the experience — if a build decision makes the experience described here slower, louder, or less honest, the build decision is wrong. It also states plainly what each platform allows, because a vision that pretends iOS permits full screen observation is a lie with a roadmap attached.

## 1. The moment we exist for

You are watching a YouTube breakdown of a company's business model. At minute 14 the creator flashes a slide — revenue mix, unit economics, one killer insight — for nine seconds. You are two taps away from a screenshot that you will never find again, and a world away from having that insight inside the project where you actually need it Thursday.

With Nova: you tap the floating button. Nova shows you a thumbnail of what it sees. You say: *"Save this revenue breakdown to the marketplace project — I want to compare their take rate with ours before Thursday."* A card confirms: the frame, the extracted numbers, the video title and timestamp, the suggested project, a drafted task with a Thursday deadline. You tap confirm. Total elapsed time: under fifteen seconds. You never left the video.

That is the whole product in one interaction: **see something → tell Nova what it means to you → it lands where it belongs, as something actionable.** Everything else in this document is that loop, elaborated across platforms and modes.

## 2. Invocation: how you summon Nova

Nova is invisible until invoked. There is no feed, no notification stream, no "daily digest" begging for attention. Invocation methods, per platform, with the honest constraints:

| Platform | Primary invocation | Also available | Constraints we don't hide |
|---|---|---|---|
| Browser (Chromium first) | Toolbar button / keyboard shortcut | Context-menu item | Sees only the browser. MV3 service-worker lifetime requires careful session handling. Firefox/Safari ports later. |
| Desktop (macOS/Win/Linux) | Floating button + global shortcut | Menu-bar/tray | macOS requires screen-recording + accessibility grants; macOS 15+ shows a recurring purple indicator and re-consent prompts. We display our own indicator anyway. |
| Android | Floating overlay button | Share sheet; long-press power/assistant mapping where the OS allows | Requires overlay permission; screen capture via MediaProjection shows a persistent notification (good — it should); AccessibilityService use faces real Play Store scrutiny. Ships after desktop/extension. |
| iOS | **Share sheet** (user pushes content in) | Shortcuts/App Intents; voice notes; in-app browser | iOS does not permit observing other apps' screens. Period. ReplayKit broadcast is user-initiated, awkward, and memory-capped (~50MB). Full Nova on iOS requires an Apple partnership or an OS change. The iOS app is a **companion**: capture what you share into it, speak notes, review and search everything. We say this plainly rather than shipping a crippled imitation of the Android experience and calling it parity. |
| Voice wake ("Nova...") | Opt-in only, on-device wake-word detection, off by default | — | Wake word is a convenience layer, never a listening excuse. Nothing is buffered or processed until the wake word fires, and the mic indicator shows when it does. |
| Hardware buttons | Where OSes allow remapping (Android assistant key, some desktop keyboards) | — | We map into whatever the OS offers; we don't pretend we can claim buttons Apple reserves. |

One principle across all of them: **invocation is a user act.** Nova never self-invokes, never captures on a timer, never records "just in case" — except the explicitly enabled Context Buffer, which is bounded, local, and indicated (see §5).

## 3. The capture interaction, second by second

The Instant Capture loop is the most rehearsed interaction in the product. Target: **under 15 seconds, under 3 decisions.**

```
 t=0s   INVOKE      User taps button / hits shortcut.

 t=0.3s SHOW        Nova displays what it sees: a live thumbnail of the
                    capture region, the detected app/page identity, and —
                    if the Context Buffer is on — a "last 60s available"
                    chip. Nothing has been stored yet.

 t=1s   SPEAK       Push-to-talk is already armed. The user says what
                    this means to them and what they want:
                    "Grab this whole thread, link it to the hiring
                     project, remind me to answer Sofia tomorrow."

 t=4s   UNDERSTAND  Nova extracts: screen text + UI structure, entities
                    (Sofia, the thread topic), the media state, and the
                    intent (save + link + reminder).

 t=6s   CONFIRM     A single confirmation card shows:
                    - what was captured (thumbnail + extracted summary)
                    - the verbatim transcript of what you said
                    - suggested project link (confidence-ranked)
                    - the drafted action(s)
                    User taps ✓, edits inline, or discards entirely.

 t<15s  DONE        Moment stored, linked, action created. The user is
                    back in their flow. A quiet toast; no celebration.
```

Design commitments inside this loop:

- **Nova shows what it sees before storing anything.** The SHOW step is the trust anchor. There is no moment where Nova has data the user hasn't seen it take.
- **The confirmation card is glanceable, not a form.** Default path is one tap. Every field is editable, but editing is the exception; if users routinely correct the project suggestion, that's a ranking bug to fix, not a UI to expand.
- **Discard is total.** Discarding at the card deletes frames, audio, transcript, everything. No "deleted items" residue.
- **Silence is fine.** If the user invokes and says nothing, Nova captures perception only and files it to the inbox as an unlabeled moment. Worse than a spoken capture, better than a lost one.

## 4. Voice: the primary intent channel

Why voice, and not a text box or a tag picker? Because the entire economics of the product rest on intent being cheap at capture time (see the [theory](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md), §2):

- Speaking one sentence costs ~3 seconds and zero context-switch — you can do it while the video keeps playing.
- Typing that sentence costs 20+ seconds and your flow.
- A tag picker costs less time but strips the intent down to a category, discarding exactly the specificity ("compare their take rate with ours") that makes the moment actionable.

So the commitments are:

- **Push-to-talk is the default** and is armed the instant the capture UI appears.
- **The transcript is shown verbatim** on the confirmation card and **stored verbatim forever** — Nova's *interpretation* of your words can be corrected; your words themselves are never lost.
- **Typing remains available** for quiet environments, and captures without any utterance are allowed (§3).
- **ASR in the MVP is cloud-based** Whisper-class with explicit disclosure; local ASR via the companion service follows. English first; that limitation is temporary and stated, not hidden.

## 5. Screen understanding and the Context Buffer

**What Nova extracts from a capture** — not just pixels:

- **Text**, with position and role: headings vs body vs fine print vs UI chrome.
- **UI semantics**: this is a chat thread with these senders; this is a data table with these columns; this is a video player at 14:22 of "How X Makes Money."
- **App/page identity**: which app, which site, which document — the anchor for provenance and for project inference.
- **Media state**: what's playing, where in it, paused or live.
- **People and entities**: names, companies, products visible in the capture, resolved against your existing memory.

In the browser this comes largely from the DOM (richer and cheaper than OCR); on desktop and Android from accessibility trees plus vision models over frames; the sources are normalized so a saved moment looks the same regardless of where it was captured.

**The Context Buffer: the answer to "you had to be there."** The most valuable second is usually the one just *before* you decided to capture — the sentence the speaker finished as you reached for the button. The Context Buffer is:

- An **opt-in** rolling window: default 60 seconds, max 5 minutes.
- Held **in RAM or encrypted temp storage on your device only**, continuously overwritten.
- **Never uploaded wholesale**, purged the moment you turn it off.
- **Always visibly indicated** while active.

When you invoke capture with the buffer on, the card offers "include the last 60s" — promoting the relevant slice into the Context Moment. It is not surveillance with a friendly name: it doesn't exist unless you enabled it, it can't leave your device as a stream, and no one — including Nova's cloud — sees it unless you promote a slice at capture time. Full mechanics in [CONTEXT_BUFFER.md](./CONTEXT_BUFFER.md).

## 6. Two modes, four real scenarios

### Instant Capture Mode

**Scenario 1 — YouTube business-model extraction.** As in §1: mid-video slide, one invocation, one sentence, and the slide's numbers land as structured data in the marketplace project with a Thursday task. Later, in the web app, the moment sits on the timeline with the video title and timestamp — click through and the source video opens at 14:22.

**Scenario 2 — Instagram idea → marketing project.** Scrolling Reels, you hit a creator's launch-announcement format that would work for your product. Tap the floating button (Android) — Nova captures the frame and the creator handle. *"Save this format to the launch-marketing project — I like the before/after hook, we should storyboard ours like this."* Confirmation card suggests "Launch Marketing," drafts a task ("Storyboard announcement using before/after hook, ref: @creator"), done. The Reel scrolled away two seconds ago; the idea didn't. (On iOS, the same outcome flows through the share sheet: share the Reel to Nova, speak the same sentence — one extra tap, same destination.)

**Scenario 3 — Tutorial → checklist.** You're reading a 4,000-word deployment tutorial you'll need next week, not now. Invoke: *"Turn the steps in this into a checklist in the infra project."* Nova extracts the procedure from the page structure — the ordered steps, the prerequisites called out in the callout boxes — and drafts a checklist, preview-then-confirm since it's writing into your task system. Next week you work the checklist, with each step linked back to the exact section of the tutorial it came from.

### Live Context Mode

Live Context is a **bounded session**: you explicitly start it, a visible indicator runs the entire time, and it explicitly ends (or hard-stops at the session cap). During the session Nova:

- observes the tab or screen you pointed it at,
- maintains the rolling buffer and transcribes audio,
- answers your push-to-talk questions grounded in what it has seen *in this session* — not the whole internet, not your whole memory, unless you ask,
- promotes segments to Context Moments only when you say "save this."

**Scenario 4 — Meeting decisions → tasks.** You start a live session at the beginning of a one-hour architecture call. Nova shows the recording indicator and, because meeting audio involves other people, a consent reminder — obtaining consent is your responsibility; keeping it visible is ours. Forty minutes in, the group settles the database question. You push-to-talk:

> *"Save this decision — we're going with Postgres and pgvector, revisit the dedicated vector DB only past 50M embeddings. Task for me: write the ADR by Friday."*

Nova saves a decision-structured moment — chosen option, rejected option, the criterion, grounded in the transcript spans where they were said — and drafts the ADR task. At session end you get a session summary: the decisions saved, the questions you asked, the moments you promoted. Nothing else from the hour is retained beyond what you explicitly saved.

Also in Live Context Mode: watching a long lecture and asking "what did she say the three failure cases were?" without scrubbing back; running a workflow while asking Nova to note the steps as you narrate them. Session cap is 30 minutes in the MVP, extended later; caps are honest resource limits, not artificial upsells.

## 7. The Memory Timeline

Capture is half the loop; the web app (and later, every client) closes it.

The **Memory Timeline** is a reverse-chronological, visually-anchored stream of your Context Moments — each rendered as its thumbnail, its one-line extracted summary, your verbatim utterance, and its links (project, people, source, actions). It is:

- **Browsable** — scroll your week the way you'd scroll a camera roll, except every item knows why it exists.
- **Searchable** — semantic and lexical: "that pricing table from the competitor video," "what Sofia said about the deadline," "the tutorial with the Docker steps." Search runs over extracted text, transcripts, your utterances, and visual embeddings.
- **Filterable** — by project, person, app/source, time range, mode (instant vs live-session), and action status ("captures with unfinished tasks").

From any moment you can:

- open the source — the video at its timestamp, the page, the thread;
- see the actions it spawned and their status;
- re-link it, annotate it, or delete it — deletion is real and cascades to derived data.

Project views assemble the same moments by effort instead of by time: everything the "Q3 pricing" project knows, its people, its decisions, its open actions.

## 8. Project linking

Projects are where moments become cumulative instead of episodic. The interaction rule is **auto-suggest + confirm, never silent filing**:

- Nova proposes the most likely project — from your utterance, content similarity, time-of-day and source patterns, people overlap — directly on the confirmation card.
- You confirm with the same single tap that confirms the capture, or redirect with one more.
- Below a confidence threshold Nova suggests nothing and the moment goes to the inbox — a wrong suggestion costs trust, an inbox costs nothing.
- Moments can belong to multiple projects or none.
- Creating a project can happen in-flow: say a project name Nova doesn't recognize and the card offers to create it.

## 9. Cross-device experience

**Capture anywhere, review anywhere.** A moment captured on your Android phone at lunch is on your desktop timeline before you're back at the desk; a live session run in your browser is reviewable on your phone that evening.

The sync model:

- What syncs is the *processed moment* — the structured record, extractions, links, thumbnails — through the backend, end-to-end within your account.
- Raw buffers never sync; they never leave the device at all (§5).
- Heavy media (full frames, session audio you chose to retain) syncs lazily and on-demand rather than eagerly to every device.

**Local-only projects.** Any project can be pinned local-only:

- Its moments are stored and indexed on the capturing device, excluded from cloud sync and cloud processing.
- That means on-device models only, so somewhat weaker extraction — a real tradeoff we surface rather than hide.
- For the sensitive client engagement, the personal medical research, the thing you simply don't want in any cloud including ours.

The MVP scopes this ambition down honestly: one browser + the web app, single user (see [MVP_SCOPE.md](./MVP_SCOPE.md)). The sync model above is the design target the MVP's data model must not foreclose.

## 10. Product principles

1. **Invisible until invoked.** No feed, no unsolicited notifications, no ambient nagging. Nova's presence is a button and a shortcut. A context tool that demands attention is defeating its purpose.
2. **Seconds, not minutes.** Invoke-to-confirmed under 15 seconds or the flow is broken. Every added decision point in the capture loop is a bug against this principle.
3. **The user always sees what was captured.** Before storage (the SHOW step), at storage (the confirmation card), and forever after (the timeline, the audit log). There is no dark inventory.
4. **Intent is spoken by the user, never assumed by the system.** Nova infers *connections* and proposes them; it does not infer *purposes*. See the theory doc's rejection of affect inference — that line holds in every feature.
5. **Bounded observation, always indicated.** Buffers are opt-in and local; live sessions have visible starts, visible indicators, and hard ends. No always-on recording, ever — as ethics, as law, and as store policy, in that order.
6. **Capture is honest per platform.** Where a platform forbids the full experience (iOS), we ship the honest companion and say why, rather than a degraded fake.
7. **Actions ask before they touch the world.** Anything leaving Nova — a Notion page, a message, an issue — is previewed and confirmed per the [Action Engine's](./ACTION_ENGINE.md) risk tiers.

## 11. Related documents

- [THEORY_OF_HUMAN_DIGITAL_CONTEXT.md](./THEORY_OF_HUMAN_DIGITAL_CONTEXT.md) — why the capture loop is shaped this way
- [MVP_SCOPE.md](./MVP_SCOPE.md) — the slice of this vision we build first
- [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md) — what runs where to deliver it
- [CONTEXT_BUFFER.md](./CONTEXT_BUFFER.md) — the buffer's guarantees in full
- [SECURITY_PRIVACY_GOVERNANCE.md](./SECURITY_PRIVACY_GOVERNANCE.md) — the commitments behind §5 and §10
- [ROADMAP.md](./ROADMAP.md) — the order in which platforms and modes arrive
