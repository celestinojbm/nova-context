# Action Engine

**Why this document.** Capture and memory justify themselves only when they change what happens next. The Action Engine is the layer that turns context + intent into things done: tasks created, issues filed, pages written, events scheduled. This document specifies the action model, the risk-tier system, the built-in and integration action catalogs, browser workflow control, approval UX, failure handling, and audit. It consumes structured outputs from the [Intelligence Engine](./INTELLIGENCE_ENGINE.md), references context from the [Memory Engine](./MEMORY_ENGINE.md), and operates under the guarantees in [SECURITY_PRIVACY_GOVERNANCE.md](./SECURITY_PRIVACY_GOVERNANCE.md).

---

## 1. Philosophy

Two truths in tension, and the whole design falls out of holding both:

1. **Context that never becomes action is cost.** Storage cost, attention cost, privacy surface. A memory system that only remembers is a diary with a subscription fee. The point of capturing a tutorial is the checklist; the point of capturing a listing is the comparison; the point of capturing "remind me to send Maya the deck" is that the deck gets sent.
2. **A wrong autonomous action destroys trust faster than no action.** A missed suggestion costs a shrug. An email sent to the wrong person, a calendar event that double-books the user, a GitHub issue filed in a public repo with private context — each one teaches the user to fear the tool, and fear is unrecoverable at product scale.

The resolution is not "always ask" (approval fatigue makes users rubber-stamp, which is worse than no gate) and not "be careful" (hope is not a control). The resolution is **risk tiers**: classify every action by blast radius and reversibility, automate freely where mistakes are cheap and undoable, and make human approval structurally unavoidable where they are not. Human approval is a first-class primitive of the engine — a state in the lifecycle with its own data model and UX — not a confirm dialog bolted on.

## 2. Action model

An **Action** is a structured record, not a function call:

```
Action = intent                 # what the user meant ("file this as a bug")
       + context references     # moment IDs that ground it
       + target                 # where it lands (nova:tasks, notion:page, github:issue…)
       + parameters             # the exact payload (schema-validated)
       + risk tier              # 0 | 1 | 2 (§3)
       + approval state         # per lifecycle below
```

Concretely, as stored in the `actions` table ([MEMORY_ENGINE.md §9](./MEMORY_ENGINE.md#9-core-schema-sketch)):

```jsonc
{
  "id": "act_01j9...",
  "user_id": "usr_...",
  "kind": "notion.create_page",
  "risk_tier": 1,
  "state": "proposed",
  "moment_ids": ["mom_1042"],                      // grounding context
  "payload": {
    "intent": "add this pricing comparison to the vendor eval notes",
    "target": { "integration": "notion", "parent": "db_vendor_eval" },
    "params": {                                    // schema-validated, previewed verbatim
      "title": "Vendly pricing — captured 2026-07-09",
      "blocks": [ /* exact content to be written */ ]
    },
    "idempotency_key": "usr..:notion.create_page:sha256(intent+moments)"
  },
  "audit": { "proposed_by_model": "anthropic/claude-fast", "proposed_at": "..." }
}
```

The parameters shown to the user at approval time are the parameters executed — the record is frozen at approval; any edit produces a new proposal.

### 2.1 Lifecycle

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> approved : auto (Tier 0)\nor human confirm (Tier 1/2)
    proposed --> rejected : human decline / expiry
    approved --> executing
    executing --> completed
    executing --> failed
    completed --> [*] : auditable record
    failed --> proposed : user-initiated retry (new attempt, same idempotency scope)
    failed --> [*] : auditable record
```

Every terminal state produces an immutable audit record (§10). "Approved" is a real state with a real approver: `auto(policy)` for Tier 0, or a user identity + timestamp for Tiers 1–2.

### 2.2 Idempotency and retries

- **Idempotency keys.** Every action carries a key derived from `(user, target, intent hash, source moment set)`. Adapters must pass it downstream where the target API supports it (GitHub, Notion, and calendar APIs all do) and must check-before-create where it doesn't. Result: a retried "create issue" can never file the issue twice, even across worker crashes.
- **Retry semantics.** Transient failures (5xx, rate limits, timeouts) retry with exponential backoff inside the same approved action, bounded (3 attempts) — the approval covers the *action*, not one HTTP attempt. Permanent failures (4xx validation, revoked auth) do not retry; they surface (§9). **A failed Tier 1/2 action never silently re-executes later** — re-execution after terminal failure requires the user to retry explicitly.
- Execution runs on BullMQ workers; the queue's at-least-once delivery is exactly why idempotency keys are mandatory rather than nice-to-have.

## 3. Risk tiers

The load-bearing table. Tier assignment is by action *type and target*, evaluated server-side; a model cannot talk an action into a lower tier, and tier assignment is code review-gated.

| Tier | Rule | Approval | Examples |
|---|---|---|---|
| **0 — auto-execute** | Internal to Nova **and** trivially reversible | None; executes immediately, visible in activity feed with one-tap undo | Create Nova task, save note, link moment to project, tag |
| **1 — preview-then-confirm** | External write, low blast radius: creates content in the *user's own* spaces, no humans notified, no money moved | Exact-payload preview + one-tap confirm; per-integration auto-approve available *after trust established* | Create GitHub issue, add Notion page, create calendar event |
| **2 — explicit approval, always** | Messages humans, spends money, deletes data, publishes publicly, or operates in bulk | Full approval card + explicit confirmation + audit; **no auto-approve exists at this tier, ever** | Send/queue any message to a person, purchase, delete external data, publish publicly, any bulk operation |

The classification, as a decision procedure:

```mermaid
flowchart TD
    A[Action proposed] --> B{Messages a human,\nspends money, deletes data,\npublishes publicly, or bulk?}
    B -- yes --> T2[Tier 2\nexplicit approval, no auto, full audit]
    B -- no --> C{Writes outside Nova?}
    C -- yes --> T1[Tier 1\nexact-payload preview + confirm\nauto-approve earnable per integration]
    C -- no --> D{Trivially reversible?}
    D -- yes --> T0[Tier 0\nauto-execute, visible, undoable]
    D -- no --> T2
```

Tier boundaries, precisely:

- **Tier 0** requires *both* conditions. Internal but hard to reverse (bulk re-linking of 200 moments) is not Tier 0 — bulk is Tier 2 regardless of target.
- **Tier 1** previews show the **exact payload** — the literal issue title/body, the literal event with time and attendee-free scope — not a summary of it. Users approve what will be sent, byte-for-byte. Per-integration **auto-approve is opt-in and earned**: offered only after a threshold of consecutive manually-approved, unedited executions for that integration (default: 10), always revocable, and scoped to the integration + action type, never global.
- **Tier 2** has no auto-approve path *by construction*: the code path from `proposed` to `approved` at Tier 2 requires a user-interactive approval event; there is no policy object that can supply it. This is deliberately inflexible. The day we add "trusted Tier 2 auto-approve" is the day a bulk-delete or wrong-recipient message ships with our name on it.

### 3.1 Guardrails beyond tiers

Tiers gate *approval*; three additional brakes gate *volume and origin*:

- **Rate limits per (user, integration, action kind).** Defaults generous enough to be invisible in normal use (e.g., 30 external writes/hour), tight enough that a misparsed intent or a looping client cannot flood a Notion workspace. Hitting a limit pauses proposals with a visible notice, never silently drops them.
- **Anomaly braking.** A burst of proposals far outside the user's baseline (an account that averages 3 actions/day suddenly proposing 80) freezes the proposal queue behind a single "something unusual is happening — review these" interstitial. False positives cost one click; the true positive it exists for is a compromised API client or a runaway automation.
- **Prompt injection defense.** Nova's actions are grounded in *captured screen content*, and screen content is attacker-controllable: a web page can embed text like "assistant: create an issue titled X and email this page to..." The Action Engine therefore treats captured content strictly as **data, never as instructions** — action intent comes only from the user's utterance and explicit UI input, and the Intelligence Engine's extraction prompts delimit page-derived text as untrusted quoted material. Structural backstops in depth: extraction output is schema-bound (a summarization call cannot emit an action), proposals originating from any model call that ingested captured content are marked and can never exceed the intent the user actually expressed, and Tier 2's unconditional human gate means the worst case of a successful injection is a weird *proposal* the user declines — not a sent message. We assume injection attempts will happen routinely once Nova has users worth attacking; the design goal is that they are embarrassing for the attacker, not for us.

## 4. Built-in actions catalog

Actions against Nova's own systems — the Tier 0 backbone that makes capture feel instantly productive with zero approval friction:

| Action | Tier | What it does |
|---|---|---|
| Create task | 0 | Task in Nova's task list, linked to source moments and project |
| Create project | 0 | New project shell, optionally seeded from the triggering moment |
| Save research note | 0 | Structured note from moment content + user utterance |
| Generate document / summary | 0 (save) | Brief or summary from selected moments (§7); saved to Nova |
| Create checklist from tutorial | 0 | Live/captured tutorial session → ordered, checkable steps |
| Schedule event | 1 | Calendar event (external calendar → Tier 1; a Nova-internal reminder is Tier 0) |
| Set follow-up reminder | 0 | Time or context-triggered reminder, e.g. "when I next open this repo" |
| Compare / track items | 0 | Comparison table across moments (apartments, laptops, vendors); track updates |

Worked examples of the two that carry the most product weight:

- **Checklist from tutorial.** User runs a Live Context Mode session over a 20-minute setup video, says "turn this into a checklist." The Action Engine takes the session transcript + saved moments, has the Intelligence Engine extract ordered steps (schema-validated: step text, source timestamp, optional command/snippet), and creates a checklist where every step deep-links to the second of video it came from. Tier 0: it lives in Nova, deleting it costs nothing, and getting it 90% right is still worth more than a browser tab the user will never reopen.
- **Compare / track.** Three captures of laptop product pages across a week, then "compare these." Nova builds a table (price, weight, RAM, battery — columns proposed by the model, editable by the user) with each cell cited to its source moment. "Track" registers the source pages for re-capture prompts; Nova does not scrape in the background (that would be unattended automation, §6) — it *prompts the user* to re-capture when they revisit, which keeps the human in the loop and the data fresh enough.

## 5. Integration actions

External targets, each behind an adapter:

- **GitHub issues** (Tier 1) — issue in a user-selected repo; payload preview shows repo, title, body, labels.
- **Notion pages** (Tier 1) — the first integration we ship, per [MVP_SCOPE.md](./MVP_SCOPE.md); page in a user-selected database/parent.
- **Calendar events** (Tier 1) — create event; *adding attendees notifies humans and therefore escalates that action to Tier 2*.
- **Generic webhook** (Tier 1 by default; user marks trusted endpoints) — signed JSON payload to a user-registered endpoint; the escape hatch for everything we haven't built.
- **Email draft** (Tier 1 for *drafting*) — Nova writes a draft into the user's drafts folder. **Never sends in MVP.** Sending email is Tier 2 and deliberately not implemented until the approval UX has proven itself; a draft the user must open and send is the right ceiling for now.

### 5.1 Adapter interface

```ts
// packages/actions/src/adapter.ts
export interface ActionAdapter<P = unknown, R = unknown> {
  readonly integration: string;            // "notion", "github", "calendar", "webhook"
  readonly actionKind: string;             // "create_page", "create_issue", ...
  readonly riskTier: 0 | 1 | 2;            // static per (integration, kind); server-enforced

  /** Build a fully-specified proposal from intent + context. Pure; no side effects. */
  propose(intent: ActionIntent, ctx: ContextRefs): Promise<ActionProposal<P>>;

  /** Validate params against schema + live target state (repo exists, auth valid). */
  validate(params: P, auth: IntegrationAuth): Promise<ValidationResult>;

  /** Execute. Must be idempotent under `idempotencyKey`. */
  execute(params: P, auth: IntegrationAuth, idempotencyKey: string): Promise<ExecutionResult<R>>;

  /** Optional compensating action. Declared, so the UI can promise undo honestly. */
  rollback?(result: ExecutionResult<R>, auth: IntegrationAuth): Promise<RollbackResult>;
}
```

`rollback` is optional because honesty beats symmetry: a Notion page can be archived, a GitHub issue can be closed-with-comment, but a delivered webhook cannot be undelivered. Adapters that can't roll back say so, and the approval card reflects it ("this cannot be undone by Nova").

### 5.2 Auth

OAuth per integration with **minimal scopes**: Notion gets access to the workspace pages the user grants, GitHub uses fine-grained tokens scoped to selected repos, calendar gets event-write only. We never ask for broad scopes to smooth future features — scope requests are per-capability, requested when the user first enables that capability. Tokens are stored encrypted, per-user, revocable from the integrations page; revocation immediately fails pending actions for that integration (permanent failure, §9), never queues them.

### 5.3 Third-party proposals via the Developer Platform

Assistants integrating through the [Nova Developer Platform](./API_AND_SDK_SPEC.md) participate in the action system under the same tier rules, gated by permission scopes:

- **`action:propose`** — the client may create actions in `proposed` state. This is the scope most integrations should hold. A proposed action from a third party renders in the user's approval surface exactly like a Nova-originated one, additionally labeled with the proposing client ("Proposed by Dona").
- **`action:execute`** — the client may drive a proposed action through execution *after* approval requirements are met. This scope never bypasses tiers: Tier 0 executes immediately, Tier 1 requires either interactive confirmation or previously earned auto-approve for that (integration, action kind), and **Tier 2 always requires interactive user approval regardless of scopes held**. There is no scope, plan tier, or partnership agreement that grants third-party auto-execution of Tier 2 actions.

Two design consequences worth stating. First, tier assignment happens in Nova's backend from the action's kind and target — a client cannot self-declare Tier 0. Second, the earned auto-approve counters (§3) are tracked per *(user, integration, action kind)*, not per client: trust earned by approving Nova's own GitHub proposals does not transfer to a third-party client's GitHub proposals, which build their own history. This is mildly annoying for well-behaved clients and exactly right for the threat model.

Webhook payloads (both the generic webhook action and platform event webhooks) are HMAC-signed with per-endpoint secrets and carry the action ID, so receivers can verify origin and deduplicate — details in [API_AND_SDK_SPEC.md](./API_AND_SDK_SPEC.md).

## 6. Browser workflow control

The extension can drive the browser — navigate, fill, click — under strict rules:

- **Visible, supervised mode only.** Workflow execution happens in a visible tab in the foreground, with a per-step overlay showing what Nova is about to do ("clicking 'Export CSV'"), a running step log, and an **instant abort** control (button + Escape) that halts before the next step. The user watches the automation happen.
- **No headless background automation of user accounts in MVP.** This is an **anti-goal**, not a gap. Background automation of authenticated sessions is where "assistant" quietly becomes "agent acting as you while you're not looking" — the single fastest way to produce a catastrophic Tier 2-equivalent event through a Tier 1-looking feature. It also violates the spirit (and increasingly the letter) of platform automation policies.
- Individual steps inherit risk tiers: a workflow that ends in a form submission that messages a human or spends money pauses at that step for Tier 2 approval, mid-flow.

What supervised execution looks like, concretely — "download last month's invoices from the billing portal":

```text
Step 1/5  Navigate to billing.vendor.com/invoices        [done  0.8s]
Step 2/5  Set date filter: June 2026                     [done  0.4s]
Step 3/5  Click "Export" on invoice #4411                [done  1.1s]
Step 4/5  Click "Export" on invoice #4412                [running…]
Step 5/5  Save files to project "Q2 books"               [pending]
                                    [ Pause ]  [ Abort (Esc) ]
```

Every step is announced in the overlay ~500ms before it fires — long enough to abort, short enough not to feel like molasses. The step log is retained in the action's audit record, so "what exactly did Nova click" is answerable after the fact. If the page differs from what the workflow expects (element missing, unexpected dialog), execution halts and asks rather than improvising — a wrong click on a live authenticated site is not a place for model creativity.
- **Future:** recorded repeatable workflows — the user performs a flow once, Nova parameterizes and replays it — under the *same* supervision rules: visible, per-step, abortable. Supervision is the invariant; convenience grows inside it.

## 7. Document generation

From moments to deliverables: select moments (or a project, or a live session) → generate briefs, meeting summaries, research digests, or comparison tables. Generated documents always carry their source-moment citations (a claim in a Nova-generated brief is traceable to the screen it came from — same provenance discipline as [MEMORY_ENGINE.md §5](./MEMORY_ENGINE.md#5-versioning)).

Supported document kinds at launch:

| Kind | Input | Output |
|---|---|---|
| Brief | Project or moment selection | 1–2 page synthesis with cited claims |
| Session summary | One live session | Chronological summary + key moments + Q&A recap |
| Research digest | Topic entity or moment set | Grouped findings, open questions, source list |
| Comparison table | 2+ moments of comparable items | Table with cited cells (§4) |

Documents are versioned like all interpretations ([MEMORY_ENGINE.md §5](./MEMORY_ENGINE.md#5-versioning)): regenerating produces a new version, and user edits become user-authored versions that regeneration never overwrites.

Saving to Nova is Tier 0. Exporting to Notion/Google Docs is a Tier 1 action through the corresponding adapter — the export preview shows the rendered document, destination, and sharing state of the destination (exporting into a *shared* space is flagged prominently, since that is publication-adjacent).

## 8. Human approval UX

Approval is a designed surface, not an interruption:

- **Approval cards** show four things, always: **what** (exact payload, §3), **where** (target with enough specificity to catch mistakes — "repo: acme/billing-service (private)"), **why** (the intent utterance that triggered it), and **which context** (thumbnails/links of the grounding moments). A user should be able to catch a wrong-repo or wrong-page mistake in two seconds of glancing.

  ```text
  ┌─ Create GitHub issue ──────────────────────────── Tier 1 ─┐
  │ WHERE  acme/billing-service (private) · label: bug        │
  │ WHY    "file this as a bug against the billing service"   │
  │ WHAT   Title: Invoice totals drift on partial refunds     │
  │        Body:  [full body shown, scrollable, verbatim]     │
  │ FROM   ▣ moment #1187 — Sentry trace, 14:02 today         │
  │                                                            │
  │ [ Edit ]                    [ Cancel ]   [ Create issue ]  │
  │ ☐ Auto-approve GitHub issues from now on (7/10 unedited)  │
  └────────────────────────────────────────────────────────────┘
  ```

  The auto-approve offer renders only once the earn threshold is in sight, and never on Tier 2 cards.
- **Batch approvals.** Related Tier 1 actions group into one card with per-item checkboxes ("Create 4 Notion pages from this research session — approve all / pick"). Tier 2 actions never batch with each other or with anything else; each gets its own card. Bulk *is* the risk.
- **Approval fatigue is a design failure we own, not a user failing.** The mitigation is **correct tier boundaries, not nagging**: keep Tier 0 genuinely generous (internal + reversible should never prompt), make Tier 1 earn auto-approve per integration (§3), and keep Tier 2 rare by keeping its scope precise. We track approval-to-edit and approval-latency metrics; if users approve Tier 1 payloads unedited >95% of the time for an integration, that is the signal to offer auto-approve — the system earns autonomy with evidence instead of assuming it.
- Pending approvals expire (default 7 days) back to `rejected`; stale context should not execute.

## 9. Failure handling

- **No silent failures — ever.** Every failed action produces a user-visible outcome: activity-feed entry, badge on the source moment, and (user-configurable) notification for approved-but-failed actions. The worst version of Nova is one the user *thinks* filed the issue.
- **Partial failure reporting.** Batch of 5, two fail: report exactly which two, why, and offer retry-failed-only. Never report a batch as "done" with casualties, and never auto-retry the successful three (idempotency keys make an accidental full-batch retry harmless anyway, §2.2).
- **Rollback where supported.** For adapters that declare `rollback`, a completed action shows undo for a bounded window; rollbacks are themselves audited actions. Where rollback isn't supported, the UI said so at approval time — no surprises at failure time.
- **Failure taxonomy drives behavior:** transient → bounded retry (§2.2); auth-revoked → fail + prompt to reconnect (never hold actions hostage waiting for re-auth); validation → fail with the exact rejection surfaced; adapter bug → fail, alert us, and trip the adapter's circuit breaker so one broken integration can't burn the queue.

A worked failure, end to end: the user approves "create Notion page" while Notion is having an outage. Attempt 1 gets a 502; the worker backs off and retries; attempt 3 fails and the action goes terminal-`failed`. The user sees a badge on the source moment and an activity entry: "Notion page not created — Notion returned server errors (3 attempts). [Retry]." The approval remains valid context but the retry is explicit — clicking Retry creates a fresh attempt under the *same* idempotency key, so if attempt 2 actually landed despite the 502, Notion's idempotent create returns the existing page instead of a duplicate, and Nova reconciles to `completed`. Every hop of this story is in the audit record.

## 10. Audit

Every action — all tiers, including Tier 0 — writes an immutable audit record:

| Field | Contents |
|---|---|
| Who | User; approver identity for Tier 1/2 (`auto(policy-id)` for Tier 0 / earned Tier 1 auto-approve) |
| What | Action kind, target, full parameter payload as executed |
| When | Proposed / approved / executed / terminal timestamps |
| Which context | Source Context Moment IDs (grounding provenance) |
| Which model | Provider + model that produced the parameters, from [INTELLIGENCE_ENGINE.md §10](./INTELLIGENCE_ENGINE.md#10-configuration-example) response metadata |
| Outcome | completed / failed (+ error class), rollback record if any |

The audit log is **user-visible in-product** — a filterable activity history answering "what has Nova done on my behalf, and why did it think that was what I wanted?" It is the user's log first and a compliance artifact second. Retention, integrity guarantees (append-only, no payload contents in operational logs), and enterprise export are specified in [SECURITY_PRIVACY_GOVERNANCE.md](./SECURITY_PRIVACY_GOVERNANCE.md).

Model provenance in the audit trail is not bureaucracy: when an action's parameters are wrong, we need to know *which model under which routing decision* produced them — that is how action failures become Intelligence Engine benchmark fixtures instead of anecdotes.

## 11. What we deliberately did not build

- **No email send, no messaging humans, in MVP** — drafts only (§5). The approval UX must earn the right to touch other people.
- **No headless automation of user accounts** — anti-goal, restated (§6).
- **No Tier 2 auto-approve, ever** — not a setting, not an enterprise feature, not for "power users" (§3).
- **No cross-user actions.** An action executes as exactly one user, under that user's grants, grounded in that user's memory. Team-level actions (post-MVP, Teams tier) will be modeled as explicitly shared projects with their own grant model — never as one user's credentials acting for another.
