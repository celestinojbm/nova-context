# A Theory of Human Digital Context

**Why this document.** Nova Context is built on a specific claim: that the meaning of what a person sees on a screen is not in the pixels, and not in the text, but in a structured combination of perception, intent, and history that today's software throws away. If that claim is wrong, Nova is a screenshot tool with extra steps. This document makes the claim precise. It defines the unit we capture, decomposes context into dimensions we can actually engineer against, and derives the design consequences that the [Context Engine](./CONTEXT_ENGINE.md) and [Memory Engine](./MEMORY_ENGINE.md) implement. Everything downstream — ranking, memory layering, decay, retrieval — is an implementation of this theory. When the theory and the code disagree, one of them is wrong and we should know which.

## 1. The core failure of current tools

Every existing capture mechanism preserves one slice of an experience and discards the rest:

| Tool | Preserves | Discards |
|---|---|---|
| Screenshot | Pixels at an instant | Why you took it, what came before, what you meant to do with it |
| Bookmark | A URL | The specific 40 seconds of the page that mattered, and your reaction |
| Note | Your words | The thing you were reacting to |
| Chat history | Utterances | The screen state that prompted them |
| Browser history | Sequence of URLs | Everything else |

The pattern: each tool captures **content** and discards **context**. Six months later you find the screenshot and cannot reconstruct why it exists. The information survived; the meaning died.

Our claim is that meaning is recoverable only if you capture, at the moment of experience, a small structured set of things together — and that this set is enumerable and finite.

## 2. Formal definition: the Context Moment

The atomic unit of human digital context is the **Context Moment**. Formally:

```
ContextMoment = (P, M, I, C, t)

  P  — Perception:  what was perceivable at time t
                    (screen frames, OCR text, UI semantics, audio transcript,
                     app/page identity, media playback state)
  M  — Meaning:     what the perception denotes, extracted and normalized
                    (entities, claims, topics, the "aboutness" of P)
  I  — Intent:      what the user wants done with it, in their own words
                    (the spoken utterance at capture time — the single most
                     valuable field, because it is unrecoverable later)
  C  — Connection:  how this moment relates to existing structure
                    (project membership, people involved, prior moments,
                     source provenance)
  t  — Time:        when, but also *where in a sequence* — position within
                    a session, a workday, a project arc
```

Three properties of this definition matter:

1. **P without I is a screenshot.** Perception alone has near-zero retrieval value after the working-memory window closes (hours). Intent is what converts an artifact into a commitment.
2. **I is only cheap at time t.** At capture, intent costs one spoken sentence ("save this pricing model for the SaaS project, I want to compare it with what Priya sent"). One week later, reconstructing that sentence costs minutes of archaeology and usually fails. This asymmetry — intent is nearly free now and nearly impossible later — is the economic foundation of the whole product.
3. **C is computable; I is not.** Connections can be inferred from M, t, and history (with user confirmation). Intent cannot be inferred without surveillance-grade behavioral modeling, which we reject (see §3.7). This is why Nova asks the user to speak and does not try to read their mind.

A Context Moment is stored as a structured record, not a blob: frames and audio in object storage, extracted text/entities/embeddings/edges in the database, the intent utterance transcribed and preserved verbatim alongside its normalized interpretation. The verbatim utterance is never discarded; normalizations can be wrong and must be re-derivable.

## 3. The dimensions of context

Each dimension below gets four treatments: what it is, what signals carry it, how we capture it, and how it fails. The failure modes are not hypothetical — they are the bugs we will actually ship if we're careless.

### 3.1 Visual context

**Definition.** The pixel-level and structural state of what the user could see: rendered frames, the UI element hierarchy, spatial layout (what was adjacent to what), and for video, the specific frames in view.

**Signals.** Screen frames; OCR text with bounding boxes; UI semantics (this region is a chat message, that is a chart, that is an ad); app and page identity; scroll position; for video, frame samples plus playback timestamp.

**Capture.** Platform-dependent and honestly uneven. In the browser we get DOM structure via content scripts — far richer than OCR, since the DOM tells us "this is a `<table>` of prices" rather than "these glyphs are near each other." On desktop, ScreenCaptureKit/Graphics.Capture frames plus accessibility trees. On Android, MediaProjection frames plus the AccessibilityService view hierarchy. On iOS, only what the user pushes through the share sheet. The Context Engine normalizes all of these into one perceptual schema so downstream layers don't care about the source.

**Failure modes.**
- *Pixel fetishism:* storing high-resolution frames and calling it done. Frames without structure are expensive to store and nearly useless to query.
- *OCR soup:* flattening a screen into an undifferentiated text blob, losing that the important number was in the header and the fine print was fine print. Spatial layout carries salience.
- *Occlusion blindness:* capturing what was on screen rather than what was visible (overlapped windows, elements below the fold). We must record visibility, not mere presence.
- *Frame-rate delusion:* sampling video at high fps. For meaning, 1 fps with good frame selection beats 30 fps of redundancy at 30x the cost.

### 3.2 Audio context

**Definition.** The sound accompanying a moment: speech from media (the YouTube narrator's actual claim), ambient speech in a meeting, and — kept strictly separate — the user's own voice.

**Signals.** Tab/system audio transcripts with timestamps; speaker turns where diarization is feasible; media identity (which video, which timestamp); the user's push-to-talk utterances as a distinct, first-class stream.

**Capture.** Tab audio via `tabCapture` in the browser; system/app audio on desktop where permitted; the user's voice always via explicit push-to-talk or an explicitly started live session. The user-voice stream is tagged as intent, never mixed into ambient transcript — confusing "what the video said" with "what the user said about the video" corrupts both M and I.

**Failure modes.**
- *Covert capture:* any audio recorded without visible indication. Prohibited absolutely — buffer audio exists only in the opt-in, indicated [Context Buffer](./CONTEXT_ENGINE.md).
- *Speaker collapse:* attributing the podcast host's claim to the user, or vice versa. Provenance of speech is part of social context (§3.6) and must survive transcription.
- *Transcript-as-truth:* ASR errors ("fifteen" vs "fifty") propagating into decisions. Confidence scores must travel with transcripts, and the original audio for a promoted moment is retained (per user policy) so errors are correctable.
- *Consent blindness:* meeting audio implicates other people. Nova displays consent reminders in Live Context Mode; the legal duty is the user's, but the design duty to make it visible is ours.

### 3.3 Conversational context

**Definition.** The structure of dialogue: who said what, in reply to what, in which thread, with what register. A message means little without its thread; "sounds good" is content-free without the proposal it answers.

**Signals.** Message text, sender identity, thread/reply structure, timestamps, platform (a Slack DM and a public tweet with identical words are different acts), and explicit tone markers present in the text itself (emphasis, punctuation, emoji as written).

**Capture.** DOM extraction in web chat clients gives us real thread structure; accessibility trees on desktop/Android give partial structure; OCR is the fallback and the weakest. We extract the visible conversation window plus whatever scrollback is in the buffer — never more than the user could see.

**Failure modes.**
- *Thread amputation:* capturing one message without its antecedents, storing a reply whose question is lost.
- *Attribution drift:* misassigning speakers when a UI renders names ambiguously (avatars, "You", collapsed messages).
- *Register flattening:* treating a sarcastic message as literal. We do not attempt sarcasm detection; we preserve the raw text and let the user's intent utterance ("Marco is joking here but the underlying number is real") carry the interpretation. That is the correct division of labor.

### 3.4 Temporal context

**Definition.** When a moment happened; where it sits in a sequence; how recently it was relevant; and the answer to the most common human memory query: "what was I doing right before this?"

**Signals.** Wall-clock time; session position (the third capture in a 40-minute research session); ordering relative to adjacent moments; recency; recurrence patterns ("every Monday she reviews metrics").

**Capture.** Trivially cheap — timestamps and monotonic sequence numbers — which is exactly why every system gets it and almost none uses it well. The value is in derived structure: session segmentation (gap-based and topic-based), sequence edges between moments, and per-dimension decay clocks (§5).

**Failure modes.**
- *Timestamp-only thinking:* storing `created_at` and believing temporal context is handled. The queryable object is the sequence, not the instant.
- *Uniform decay:* aging all context on one clock. A meeting decision from March may be load-bearing today; the March screenshot of a draft slide is noise. Decay is per-dimension (§5).
- *Session blindness:* treating each capture as independent when the user experienced them as one continuous investigation. Moments captured minutes apart in the same app cluster are almost always one episode.

### 3.5 Project context

**Definition.** Which ongoing effort a moment belongs to. Humans do not experience information as a stream of atoms; they experience it as material for the handful of things they are trying to do. Project membership is the single highest-leverage connection in C, because it lets a moment inherit intent from its container: a pricing screenshot linked to "Q3 pricing revamp" is 80% interpreted before the user says a word.

**Signals.** Explicit assignment (the user says the project name in their utterance); lexical/semantic overlap between M and project material; temporal adjacency to other moments in the project; app/site patterns per project; people overlap.

**Capture.** Auto-suggest, always confirm. The Context Engine proposes a project link with a confidence score; the confirmation card lets the user accept in one tap or redirect. We never silently file a moment into a project — a confidently wrong filing is worse than an inbox, because the user stops trusting the filing.

**Failure modes.**
- *Over-eager linking:* the false positive that teaches the user Nova guesses wrong. Below a confidence threshold, we suggest nothing and leave the moment in the inbox.
- *Project ontology rigidity:* forcing every moment into exactly one project. Real moments are sometimes ambient ("interesting, no home yet") or multi-project. The schema allows zero-or-many links.
- *Intent inheritance abuse:* assuming project membership fully determines intent. It narrows the interpretation space; the user's utterance still governs.

### 3.6 Social context

**Definition.** The people dimension: who was involved in a moment, what the user's relationship to them is, and — critically — provenance: who is the source of a claim, and through whom did it arrive.

**Signals.** Names and identities visible in the capture (meeting participants, message senders, video creators, doc authors); the user's utterance naming people ("what Priya sent"); recurrence of the same person across moments, which builds the relationship layer of the [Memory Engine](./MEMORY_ENGINE.md).

**Capture.** Entity extraction from P and I, resolved against a per-user people registry that the user can see and edit. Identity resolution is conservative: two "Alexes" are distinct until evidence merges them, and merges are user-visible.

**Failure modes.**
- *Provenance loss:* storing "the API will be deprecated in June" without "according to a comment by someone on a forum thread." A claim's reliability is inseparable from its source; M without this slice of C is misinformation-shaped.
- *Relationship inference creep:* inferring "close friend" or "difficult colleague" from interaction patterns. We store observable facts (co-occurrence, stated roles) and let the user annotate relationships; we do not score them.
- *Other-party exposure:* social context is data *about people who never consented to Nova*. This drives hard rules: no face recognition, no building profiles of non-users beyond what the user explicitly captured, aggressive support for redaction.

### 3.7 Emotional and contextual signals — handled narrowly, on purpose

**Definition.** The affective coloring the *user explicitly puts into their utterance*: stated excitement ("this is exactly what I've been looking for"), stated urgency ("I need this before Thursday's call"), stated doubt ("not sure this source is legit").

**Signals.** The words of the intent utterance, and only those. Explicit lexical markers of priority, enthusiasm, skepticism, urgency.

**Capture.** Ordinary NLP over I: if the user says it's urgent, the moment carries an urgency flag and the [Action Engine](./ACTION_ENGINE.md) treats deadlines accordingly. If the user says they're excited, ranking may boost the moment. That's all.

**What we reject, explicitly.** We do not infer emotion from voice prosody, typing cadence, capture frequency, dwell time, facial anything, or physiological signals. Three reasons, any one of which would suffice. First, accuracy: affect inference from behavioral traces is unreliable across individuals and cultures, and a system that acts on wrong emotional guesses is worse than one that ignores emotion. Second, trust: the moment users suspect the tool is watching their mood, they change their behavior toward it — surveillance destroys the candor that makes intent utterances valuable. Third, principle: Nova's contract is "I capture what you show me and what you tell me." Inferred affect is neither. A context platform that psychoanalyzes its users has crossed from tool to watcher, and we will not cross that line even where it would be profitable.

**Failure mode of our own policy:** missing genuinely useful signals (a user who never says "urgent" but always is). We accept this cost. The correction channel is product design — making it effortless to state priority — not inference.

### 3.8 Decision context

**Definition.** The structure of choices: what options were on the table, what criteria mattered, what was chosen, what was rejected, and the stated why. Organizations and individuals bleed enormous value here — decisions get made in meetings and calls, and three months later nobody can reconstruct why option B lost.

**Signals.** Comparison structures visible in P (tables, pro/con lists, competing tabs); decision language in transcripts ("let's go with", "we ruled out", "the blocker was"); the user's explicit utterance ("we decided on Postgres, save the reasoning from this doc").

**Capture.** Two paths. Explicit: the user invokes capture at a decision point and narrates it — highest fidelity, and the confirmation card reflects the extracted decision structure (chosen / rejected / criteria) for correction. Assisted: in Live Context Mode, the Context Engine flags decision-shaped segments of a meeting and offers them for saving. It offers; it does not autonomously record "decisions" into memory, because a hallucinated decision in long-term memory is one of the most damaging errors this system could make.

**Failure modes.**
- *Premature crystallization:* recording a tentative leaning as a final decision. Decision records carry status (proposed/decided/revisited) and are versioned.
- *Rationale invention:* the extraction model back-filling plausible-sounding reasons that were never stated. Extracted rationales must be grounded in transcript spans, with links to them.
- *Losing the losers:* storing only the chosen option. The rejected options and the criteria are most of the value — they are what you need when circumstances change and the decision must be revisited.

### 3.9 Historical context

**Definition.** The second-order dimension: how the meaning of a moment changes as the projects around it evolve. A capture of a competitor's pricing page meant "reference point" in March, "the thing our launch undercut" in June, and "obsolete" in October. The moment did not change; its meaning did.

**Signals.** Project state transitions (active → shipped → archived); later moments that supersede, confirm, or contradict earlier ones; explicit user re-annotation; decision records that resolve what a moment was pending on.

**Capture.** Not captured — *maintained*. The [Memory Engine](./MEMORY_ENGINE.md) implements this as versioned interpretation: the original record (P, I verbatim, t) is immutable; the interpretive layer (M's normalization, C's links, relevance state) is versioned and re-derivable. Re-interpretation runs when projects change state and when contradicting moments arrive, and it produces annotations ("superseded by moment #4812"), never destructive edits.

**Failure modes.**
- *Frozen meaning:* retrieval surfacing a stale moment as if current — quoting March pricing in October with no supersession marker.
- *Retroactive rewriting:* letting re-interpretation touch the original record. What the user saw and said at time t is historical fact; only its interpretation ages.
- *Unbounded re-processing:* re-interpreting everything on every change. Re-interpretation is triggered, scoped to affected subgraphs, and lazy where possible.

## 4. Context composition: how dimensions become meaning

The dimensions are not a checklist; they are factors whose *product* is meaning. Composition has three properties that drive system design:

**Meaning is multiplicative, not additive.** A frame (visual) of a pricing table, in a competitor-research session (temporal), inside the "Q3 pricing" project (project), captured while the user said "this undercuts us, flag for Thursday" (intent + explicit urgency), from the competitor's own site (social/provenance) — each dimension multiplies the interpretability of the others. Strip any one and specific downstream actions become guesses. This is why the Context Moment is captured as a unit at time t rather than assembled later from separate stores: joining after the fact loses the cross-references that only exist at the moment of experience.

**Dimensions disambiguate each other.** "Send this to Alex" is under-determined by I alone. Social context resolves *which* Alex (the one on this project); conversational context resolves *this* (the message thread on screen, not the whole page); project context resolves the register (the client Alex gets a different framing than the co-founder Alex). Ranking and action synthesis must therefore operate on the composed moment, not on per-dimension indexes queried independently.

**Composition is where confidence must be honest.** Each extracted element carries confidence; composition propagates it. A high-confidence OCR extraction inside a low-confidence project link yields an action proposal that must be presented tentatively. The confirmation card is the UI expression of composed confidence — it shows what Nova is sure of and what it is guessing.

## 5. Context decay: different half-lives per dimension

Context loses value over time, but at radically different rates per dimension. Treating decay as uniform is the classic mistake (it is why "recent files" lists are useless). Approximate half-lives that our defaults encode:

| Dimension | Typical half-life | Why |
|---|---|---|
| Visual (raw frames) | Hours–days | Pixel state is superseded the next time the app renders |
| Audio (ambient transcript) | Days | Useful until summarized; the summary outlives the transcript |
| Conversational | Days–weeks | Threads resolve; the resolution matters, the back-and-forth fades |
| Temporal (sequence) | Weeks | "What was I doing before" queries concentrate in the recent past |
| Emotional markers | Days | Stated urgency expires with the deadline it referenced |
| Project | Life of the project | Membership is load-bearing until the project closes, then archival |
| Decision | Years | Decision rationale appreciates — most valuable exactly when memory of it is gone |
| Social/provenance | Years | Relationships and source reliability compound |
| Historical (interpretation) | Does not decay | It *is* the record of change |

Two design consequences. First, **decay is compression, not deletion**: a moment's raw frames can be demoted to a thumbnail plus extraction after the visual half-life, while its decision content persists in full — storage cost tracks residual value. Deletion happens only by user action or user-set retention policy. Second, **decay curves are per-dimension inputs to ranking**: the retrieval score of a moment is composed from per-dimension freshness, so a two-year-old decision record outranks a two-day-old screenshot for a "why did we choose X" query. Both mechanisms live in the [Context Engine](./CONTEXT_ENGINE.md); the layered storage that makes them cheap lives in the [Memory Engine](./MEMORY_ENGINE.md).

## 6. Implications for system design

This theory is falsifiable and load-bearing. Concretely:

1. **Intent capture is the product's spine.** Because I is unrecoverable after time t (§2), the voice path — push-to-talk, fast ASR, verbatim retention — gets latency and reliability budgets ahead of everything else. A capture flow that drops the utterance has captured a screenshot.
2. **The Context Engine ranks composed moments, not documents.** Retrieval scoring combines per-dimension decay (§5), project scope, provenance weight, and intent-match — see [CONTEXT_ENGINE.md](./CONTEXT_ENGINE.md). Pure embedding similarity over flattened text would discard exactly the structure this theory says carries meaning.
3. **The Memory Engine's layers mirror the half-life table.** Working/session memory holds fast-decaying dimensions; project memory holds membership and inherited intent; relationship memory holds the slow social dimension; long-term memory holds decisions and versioned interpretation — see [MEMORY_ENGINE.md](./MEMORY_ENGINE.md). The layering is not an architectural fashion; it is the decay table implemented as storage tiers.
4. **Confirmation is epistemically necessary, not UX politeness.** Because C is inferred and M is extracted, both are fallible; because I is authoritative, the user is the only party who can certify a composition. The confirmation card and the Action Engine's risk tiers follow directly.
5. **The rejection of inferred affect (§3.7) and of covert capture (§3.2) are theory-level commitments.** They bound what P and I may contain, on any platform, in any tier, for any customer. Features that require violating them are out of scope permanently — see [PRIVACY_AND_TRUST.md](./PRIVACY_AND_TRUST.md).
6. **Historical re-interpretation requires immutable originals.** The append-only moment record plus versioned interpretation (§3.9) is a schema commitment made now, because it cannot be retrofitted after mutable records have destroyed provenance.

What would falsify the theory? If alpha users' captures with intent utterances are not dramatically more retrieved, more project-linked, and more action-converted than utterance-less captures, then intent is not the spine we claim, and the product should be rethought. We will instrument exactly that comparison from the first prototype — see [ROADMAP.md](./ROADMAP.md).

## 7. Related documents

- [PRODUCT_VISION.md](./PRODUCT_VISION.md) — the theory expressed as user experience
- [CONTEXT_ENGINE.md](./CONTEXT_ENGINE.md) — perception, ranking, and decay implementation
- [MEMORY_ENGINE.md](./MEMORY_ENGINE.md) — layered memory and versioned interpretation
- [ACTION_ENGINE.md](./ACTION_ENGINE.md) — turning composed context into risk-tiered action
- [PRIVACY_AND_TRUST.md](./PRIVACY_AND_TRUST.md) — the commitments in §3.2 and §3.7, in depth
