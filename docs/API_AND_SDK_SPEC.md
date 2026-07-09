# API & SDK Specification — The Nova Developer Platform

**Why this document:** Nova Context is infrastructure-first. The Nova app is a reference client; the durable product is the context/memory/action substrate that *other* assistants — Dona, ChatGPT, Claude, Gemini, Copilot, Perplexity, Cursor, enterprise agents, and eventually robots and wearables — plug into. This document specifies the contract those clients build against: auth, scopes, REST surface, live streams, events, SDKs, plugins, and the marketplace. It is the developer-facing companion to [System Architecture](./SYSTEM_ARCHITECTURE.md) and inherits every constraint in [Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md). Platform economics are in [Business Model](./BUSINESS_MODEL.md).

## 1. API principles

These are not style preferences; they are the load-bearing rules every endpoint is designed against.

1. **The user is the root authority.** Third parties act under user-granted scopes. They never own the context, never hold a copy Nova can't revoke access to at the API boundary, and never inherit access from another integration. A grant is a lease, not a transfer.
2. **Least privilege by construction.** Scopes are narrow, per-project grantable, and default to the minimum. An assistant that needs to read memory in one project gets `memory:read` on that one project — not account-wide.
3. **Everything is auditable.** Every API call that touches user context writes to the user-visible audit log (see [Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md#6-audit-logs)). There is no unaudited access path, including for Nova's own first-party clients.
4. **Stable, versioned contracts.** All endpoints live under `/v1`. Breaking changes mean a new version, never a mutation of the old one. Deprecation windows are 12 months minimum (§12).
5. **Push over polling.** Webhooks and streams (SSE, WebSocket) are the primary way to learn that something happened. Polling endpoints exist but are rate-limited to discourage abuse as a substitute for events.
6. **Idempotency keys on all writes.** Every `POST`/`PATCH`/`DELETE` accepts an `Idempotency-Key` header (UUID, retained 24h). Retries are safe by default; distributed clients don't need to invent their own dedup.

## 2. Authentication

| Caller | Mechanism | Notes |
|---|---|---|
| End user (Nova's own clients, third-party apps acting as the user) | **OAuth 2.1 + PKCE** | Authorization-code flow only. No implicit flow, no password grant. Refresh tokens are rotating and sender-constrained where the platform supports it. |
| Service (backend integrations, workers) | **Scoped API keys** | Keys are created per-integration, carry an explicit scope set, and are prefixed (`nova_sk_live_…`, `nova_sk_test_…`) so secret scanners catch leaks. |
| Enterprise service | Scoped API keys **+ optional mTLS** | Mutual TLS binds a key to a client certificate; a leaked key alone is useless. Required for self-host/VPC deployments that call back to Nova cloud services. |
| Assistant acting for a user | **OAuth 2.0 Token Exchange (RFC 8693)** | The assistant exchanges its service credential + the user's grant for a short-lived *delegated* token whose scopes are the intersection of what the assistant holds and what the user granted. Both identities appear in the audit log. |

Access tokens are short-lived (**15 minutes**). Refresh tokens rotate on every use; reuse of a rotated refresh token revokes the whole grant chain (theft signal). Delegated tokens from token exchange are capped at 15 minutes and are never refreshable — the assistant must re-exchange, which re-checks that the user grant still exists. This makes revocation take effect within minutes, at the cost of more token traffic. We accept that cost deliberately: revocation latency is a trust property, token traffic is just load.

## 3. Permission scopes

Scopes are the unit of consent. Two properties matter more than the names:

- **Per-project grantability.** Every scope except `profile:read` can be granted account-wide *or* on a named set of projects. "Dona may read memory in my *Kitchen Renovation* project and nothing else" is a first-class grant, enforced at the query layer, not filtered after retrieval.
- **Consent screens are per-grant, not per-app.** High-risk scopes always show the user a dedicated consent screen naming the requesting party, the scope, and the project set.

| Scope | Description | Risk | Per-grant consent screen |
|---|---|---|---|
| `context:read` | Read stored Context Moments (frames, transcripts, extracted text, metadata) within granted projects. | High | Yes |
| `context:capture` | Submit new Context Moments on the user's behalf (e.g., an assistant pushing content the user shared into it). Cannot read anything back without `context:read`. | Medium | Yes |
| `context:live` | Join a **user-initiated** live session and receive real-time context (see §7). Never grants background access. | Critical | Yes, per session category, plus in-session indicator |
| `memory:read` | Read memory items and knowledge-graph entities in granted projects. | High | Yes |
| `memory:write` | Create or amend memory items (source-attributed; third-party writes are always marked as such and separable). | Medium | Yes |
| `memory:search` | Run semantic/hybrid queries over granted projects. Returns snippets + provenance, not bulk export. | High | Yes |
| `project:read` | List projects the grant covers; read project metadata (name, description, counts). Not contents. | Low | No (shown in summary consent) |
| `project:write` | Create projects, edit metadata, link moments to projects. | Medium | Yes |
| `action:propose` | Propose actions into the user's approval queue (§8). Cannot execute anything. | Low | No (shown in summary consent) |
| `action:execute` | Execute Tier 0/Tier 1 actions after Nova's own approval flow completes. Never bypasses Tier 2 approval. | High | Yes |
| `profile:read` | Read display name, locale, timezone, plan tier. Never email/contacts without a separate explicit grant. | Low | No (shown in summary consent) |

Scope rules worth stating explicitly:

- Scopes do not imply each other. `memory:search` without `memory:read` returns snippets and provenance references, not full memory items — useful for assistants that only need grounding hints.
- `context:live` is the only scope that grants real-time visibility, and it is only valid inside a session the user started (§7). There is no scope that grants ambient or background observation. We will not add one.
- Granting a scope on project *P* grants nothing about the existence or contents of any other project. Cross-project queries under a per-project grant fail closed with `403 scope_project_mismatch`, not with filtered results — silent filtering hides misconfiguration from developers.

## 4. REST API surface

Base URL `https://api.novacontext.dev/v1`. JSON everywhere; timestamps are RFC 3339 UTC; IDs are prefixed ULIDs (`cm_…` moments, `prj_…` projects, `act_…` actions, `ses_…` live sessions, `evt_…` events). Errors follow RFC 9457 (`application/problem+json`).

| Method & path | Purpose | Key scopes |
|---|---|---|
| `POST /v1/context/moments` | Submit a capture (Context Moment) | `context:capture` |
| `GET /v1/context/moments/:id` | Fetch a moment | `context:read` |
| `POST /v1/context/search` | Search moments (text + filters) | `memory:search` or `context:read` |
| `POST /v1/live/sessions` | Open a live session (user-initiated) | `context:live` |
| `GET /v1/live/sessions/:id` | Session state | `context:live` |
| `WS /v1/live/sessions/:id/stream` | Bidirectional live stream | `context:live` |
| `POST /v1/memory/query` | Hybrid retrieval over memory | `memory:search` |
| `GET /v1/memory/items/:id` | Fetch a memory item | `memory:read` |
| `GET /v1/projects` | List granted projects | `project:read` |
| `POST /v1/projects` | Create a project | `project:write` |
| `POST /v1/actions` | Propose an action | `action:propose` |
| `GET /v1/actions/:id` | Action state (incl. approval status) | `action:propose` |
| `POST /v1/actions/:id/approve` | Approve (first-party surfaces only; see §8) | user session only |
| `GET /v1/events` | SSE stream of user-session events | varies by event type |
| `POST /v1/webhooks` | Register a webhook subscription | service key |
| `GET /v1/audit/entries` | User's own audit log (first-party + user tooling) | user session only |

### 4.0 Wire conventions

- **Errors** are RFC 9457 problem documents with a stable machine code:

```json
{
  "type": "https://api.novacontext.dev/errors/scope_project_mismatch",
  "title": "Scope not granted for project",
  "status": 403,
  "code": "scope_project_mismatch",
  "detail": "memory:read is granted for prj_01J8… but not prj_01J7…",
  "request_id": "req_01J9…"
}
```

  `request_id` appears on every response and in the audit log, so a user, a developer, and Nova support can all point at the same event.
- **Pagination:** cursor-based (`?cursor=…&limit=…`, `next_cursor` in responses). No offset pagination anywhere — offsets leak collection size and break under concurrent writes.
- **Rate limits:** returned on every response (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`); `429` includes `Retry-After`. Defaults per token: 300 req/min general, 60/min for `memory/query` and `context/search` (per-user-grant), burst 2×. Limits are per user-grant, not just per key, so one noisy user cannot exhaust a service's quota for everyone.

### 4.1 `POST /v1/context/moments`

```http
POST /v1/context/moments
Authorization: Bearer <delegated-token>
Idempotency-Key: 018f3c1e-9d2a-7b3c-a1e4-5f6a7b8c9d0e
Content-Type: application/json
```

```json
{
  "source": { "client": "dona-android", "surface": "share_sheet" },
  "captured_at": "2026-07-09T14:22:31Z",
  "app_context": { "app": "com.android.chrome", "url": "https://example.com/pricing", "title": "Pricing – Example" },
  "media": [
    { "kind": "frame", "upload_id": "up_01J9…", "mime": "image/webp" }
  ],
  "text": { "dom_extract": "…", "ocr": null },
  "utterance": { "transcript": "save this pricing table to the vendor comparison", "language": "en" },
  "suggest_project": true
}
```

Response `201 Created`:

```json
{
  "id": "cm_01J9X4T7…",
  "status": "enqueued",
  "project_suggestion": { "project_id": "prj_01J8…", "name": "Vendor comparison", "confidence": 0.87, "requires_user_confirmation": true },
  "enrichment_eta_ms": 2500
}
```

Media binaries go through a separate presigned-upload step (`POST /v1/uploads` → PUT to object storage) so the JSON API never carries blobs. Enrichment (OCR cleanup, entity extraction, embedding, linking) is asynchronous; subscribe to `moment.enriched` rather than polling.

### 4.2 `POST /v1/context/search`

```json
{
  "query": "pricing table we saw for the CRM vendors",
  "filters": { "project_ids": ["prj_01J8…"], "captured_after": "2026-06-01T00:00:00Z", "apps": ["chrome"] },
  "limit": 10
}
```

Response items include `moment_id`, `snippet`, `score`, and `provenance` (source app/url, capture time, capture surface). Search never returns content from projects outside the token's grant.

### 4.3 Live sessions: `POST /v1/live/sessions` + WebSocket

```json
{
  "mode": "live_context",
  "surface": { "client": "nova-extension", "target": "tab", "tab_title": "Q3 Planning – Meet" },
  "max_duration_s": 1800,
  "participants": [{ "party": "dona", "scopes": ["context:live"] }]
}
```

Response returns `session_id`, a WebSocket URL, and per-participant short-lived stream tokens. The WebSocket at `WS /v1/live/sessions/:id/stream` carries **frames up, insights down**:

```jsonc
// client → server (capture client only)
{ "type": "frame", "seq": 481, "ts": "2026-07-09T14:25:02Z", "payload_ref": "inline-webp-base64|upload_id", "sampling_fps": 1 }
{ "type": "audio_chunk", "seq": 482, "codec": "opus", "payload": "…" }
{ "type": "user_utterance", "text": "what discount did they just mention?" }
{ "type": "save_moment", "window_s": 45 }          // promote buffer → Context Moment
{ "type": "end_session" }

// server → participants (assistants receive these; they never receive raw frames)
{ "type": "insight", "seq": 291, "text": "Speaker mentioned a 14% volume discount above 500 seats", "grounding": ["frame:479", "asr:22:31-22:44"], "confidence": 0.82 }
{ "type": "answer", "in_reply_to": "user_utterance:483", "text": "…", "grounding": ["…"] }
{ "type": "session_state", "state": "active|ending|ended", "elapsed_s": 912 }
{ "type": "moment_created", "moment_id": "cm_01J9…" }
```

Design choice: third-party participants receive **insights and answers, not the raw frame/audio stream**. Raw perception stays between the user's capture client and Nova's Context Engine. This narrows what a compromised or over-curious integration can exfiltrate, at the cost of some third-party flexibility. We consider that trade obviously correct; partners who need raw pixels can build a capture client and become subject to capture-client review instead.

Sessions are hard-capped (default 30 min), visibly indicated on the capture surface, and end on user command, cap, disconnect, or scope revocation — whichever comes first.

### 4.4 `POST /v1/memory/query`

Hybrid retrieval (vector + lexical + graph filters) over the Memory Engine:

```json
{
  "query": "who did I talk to about the API pricing and what did we agree",
  "retrieval": { "strategy": "hybrid", "k": 8, "min_confidence": 0.5 },
  "filters": { "project_ids": ["prj_01J8…"], "layers": ["project", "relationship"], "time_range": { "after": "2026-05-01T00:00:00Z" } }
}
```

```json
{
  "results": [
    {
      "memory_id": "mem_01J9…",
      "layer": "relationship",
      "summary": "Agreed with Priya (Acme) on usage-based pricing pilot, decision pending legal review",
      "confidence": 0.78,
      "provenance": [
        { "moment_id": "cm_01J8…", "captured_at": "2026-06-12T09:14:02Z", "source": "meet.google.com" }
      ],
      "last_verified_at": "2026-06-12T09:20:11Z"
    }
  ],
  "query_id": "q_01J9…"
}
```

Every result carries **provenance and confidence**. Assistants must be able to tell users *why* Nova believes something; a memory API that returns bare strings trains downstream assistants to hallucinate with our data attached. Rate limits: 60 queries/min per user-grant, 600/min per service key (burst 2×), `429` with `Retry-After`. Metered billing applies above plan quotas ([Business Model](./BUSINESS_MODEL.md)).

### 4.5 Actions: `POST /v1/actions` and approval

```json
{
  "kind": "notion.page.create",
  "project_id": "prj_01J8…",
  "proposal": { "title": "CRM vendor pricing comparison", "content_ref": "cm_01J9X4T7…" },
  "requested_tier": 1,
  "rationale": "User asked Dona to file the captured pricing table"
}
```

Response: `202 Accepted` with `{ "id": "act_01J9…", "state": "pending_approval", "tier": 1 }`. The proposer then watches `action.approved` / `action.rejected` / `action.executed` events. `POST /v1/actions/:id/approve` is callable only from an authenticated **user session on a first-party surface** (web app, extension) — see §8.

## 5. Event streams

**Webhooks** (service-to-service): register a subscription with a URL and event filter. Deliveries are signed with `Nova-Signature: t=<ts>,v1=<hmac-sha256>` over `<ts>.<body>` using the per-endpoint secret; verify the timestamp within 5 minutes to kill replays. Retries: exponential backoff (1m, 5m, 30m, 2h, 8h, 24h), then the delivery moves to a **dead-letter queue** visible in the developer dashboard with one-click redelivery. Endpoints failing for 7 days are auto-disabled with an email warning.

**SSE** (`GET /v1/events`): per-user session stream for clients that hold a user token — the web app, extensions, and assistants maintaining a live UI. Supports `Last-Event-ID` resume.

**Event taxonomy** (dot-namespaced, versioned within `/v1`):

```
moment.created        moment.enriched        moment.linked          moment.deleted
memory.updated        memory.forgotten
project.created       project.updated
action.proposed       action.approved        action.rejected        action.executed   action.failed
session.started       session.insight        session.ended
grant.created         grant.revoked
audit.third_party_access        # emitted to the USER's stream whenever a third party reads their data
```

`audit.third_party_access` is deliberate: users can build (or install) watchdogs over their own data access in real time.

## 6. Context requests — "what is the user looking at right now?"

The question every assistant wants to ask. The answer is governed by one rule:

> **Inviolable rule: real-time context is only available inside a live session the user explicitly started, to parties holding `context:live` for that session. There is no background access, no "last known screen" endpoint, no polling loophole. This rule has no enterprise override, no partner-tier exception, and no debug flag.**

Mechanics: the user invokes Live Context Mode; the capture client opens the session (§4.3) and lists participant assistants; each participant connects to the stream and receives insights/answers scoped to that session. When the session ends, the party's real-time visibility ends — what persists is only what was promoted into Context Moments, readable later under `context:read`/`memory:read` if granted. An assistant asking "what is on screen" outside a session gets `409 no_active_session`, and the attempt is written to the user's audit log. Repeated probing is a marketplace-policy violation (§11).

## 7. Memory requests

Recommended query patterns:

- **Grounding lookups** (assistant answering a user question): `memory/query` with `k ≤ 8`, `min_confidence ≥ 0.5`, project-filtered. Show provenance to the user.
- **Session priming** (assistant starting a conversation): one query per session start against `layers: ["project", "working"]`, cached client-side for the session. Do not re-query per message; rate limits assume you don't.
- **Entity lookups**: filter `layers: ["relationship", "semantic"]` with an `entity` filter for "what do we know about Acme Corp" questions.

Responses always include provenance and confidence (§4.4). Bulk export of memory is *not* available to third parties under any scope; users export their own data via the first-party DSAR/export tooling ([Security, Privacy & Governance](./SECURITY_PRIVACY_GOVERNANCE.md#10-enterprise-compliance)). This asymmetry is intentional: retrieval is a lease, export is an ownership act only the user performs.

## 8. Action requests

Third parties **propose**; Nova's risk tiers govern execution ([Action Engine](./ACTION_ENGINE.md)):

| Tier | Meaning | Third-party position |
|---|---|---|
| 0 | Internal, reversible (create task, link moment) | Executable with `action:execute`, still audited |
| 1 | External writes with preview (create Notion page, calendar draft) | Proposer supplies preview; Nova shows preview-then-confirm to the user unless the user has standing-approved that action kind for that party |
| 2 | Data leaves user's control: messages to people, purchases, publishing | **Always** explicit per-instance user approval on a first-party surface. A third party can never approve, batch-approve, or pre-approve Tier 2. No API path exists that lets the proposing party confirm its own proposal. |

Approval is a first-class primitive: proposals carry rationale and content references, sit in a reviewable queue in the web app, and every transition is an event and an audit entry. If an integration is found repackaging Tier 2 semantics as a Tier 1 action kind (e.g., "webhook to my server that then emails people"), that action kind is reclassified and the integration flagged in review.

## 9. SDK design

TypeScript first (the platform's own language; see [Repo Structure](./REPO_STRUCTURE.md)), then Kotlin, Swift, Python. All SDKs are open source, MIT-licensed, generated from the same OpenAPI + AsyncAPI definitions in `packages/schema` so they cannot drift from the server.

```ts
import { NovaClient } from "@nova-context/sdk";

const nova = new NovaClient({
  auth: { type: "token_exchange", serviceKey: process.env.NOVA_SK!, userGrant: grantToken },
  // mock: true  → fully local, synthetic data, no network (see §12)
});

// Submit a capture the user pushed into your assistant
const moment = await nova.context.requestCapture({
  source: { client: "dona-android", surface: "share_sheet" },
  media: [{ kind: "frame", data: frameBytes, mime: "image/webp" }],
  utterance: { transcript: "save this to the vendor comparison" },
  idempotencyKey: crypto.randomUUID(),
});

// Ground an answer in the user's memory
const memories = await nova.memory.query({
  query: "what did the user agree with Acme about pricing?",
  filters: { projectIds: [moment.projectSuggestion!.projectId], layers: ["project", "relationship"] },
});
for (const m of memories.results) console.log(m.summary, m.confidence, m.provenance);

// Propose an action — the user, not Dona, decides
const action = await nova.actions.propose({
  kind: "notion.page.create",
  projectId: moment.projectSuggestion!.projectId,
  proposal: { title: "CRM vendor pricing comparison", contentRef: moment.id },
  rationale: "User asked to file the captured pricing table",
});

// Join a user-initiated live session
const session = await nova.live.join(sessionId);
session.on("insight", (i) => dona.surfaceInsight(i.text, i.grounding));
session.on("answer", (a) => dona.speak(a.text));
session.on("ended", () => dona.clearLiveContext());
```

SDK guarantees across languages: typed models generated from `packages/schema`; automatic idempotency keys on writes; token refresh/exchange handled internally; webhook signature verification helpers; retry with jittered backoff on `429`/`5xx`; no silent scope widening — a `403` surfaces as a typed `ScopeError` naming the missing scope so developers request the right grant instead of asking for everything.

## 10. Plugins

Plugins extend Nova server-side in three shapes:

- **Context extractors** — enrich moments from specific sources (e.g., a Figma extractor that turns a captured Figma tab into structured layers/components instead of OCR soup).
- **Action adapters** — new action kinds (e.g., `linear.issue.create`), including the preview renderer for Tier 1 flows.
- **Memory processors** — post-enrichment analyzers (e.g., a legal-terms detector that tags contract clauses in captured documents).

Manifest sketch (`nova-plugin.json`):

```jsonc
{
  "name": "figma-extractor",
  "version": "1.2.0",
  "kind": "context_extractor",
  "entry": "dist/index.js",
  "runtime": "nodejs22",
  "scopes": ["context:read"],                 // max scopes; user grant may be narrower
  "triggers": [{ "event": "moment.created", "filter": { "app_context.url": "*.figma.com/*" } }],
  "limits": { "timeout_ms": 10000, "memory_mb": 256 },
  "egress": []                                 // allowlisted domains; empty = no network
}
```

Sandboxing stance: server-side plugins run **isolated** (V8 isolates or Firecracker microVMs, decided per runtime), with declared scopes enforced at the API layer — a plugin calls the same `/v1` API as any external client and gets the same audit entries. Default egress is *none*; every allowed domain is user-visible at install time. A plugin cannot read anything its user grant doesn't cover, cannot see other users, and cannot persist outside its declared storage quota. The cost of this stance is that plugins are slower and more constrained than in-process extensions would be; we pay it because plugins are the single most likely channel for a supply-chain attack against user context.

## 11. Marketplace

- **Review process:** automated scans (manifest/scope lint, dependency audit, secret scan, egress diff) on every submission; human security review for anything requesting High/Critical scopes (`context:read`, `context:live`, `memory:read`, `memory:search`, `action:execute`) or any egress. Re-review on scope or egress changes, not on every patch release.
- **Security requirements:** published privacy policy; data-handling declaration (what leaves Nova, where it goes, retention); no scope hoarding — requested scopes must map to demonstrated features, and reviewers reject "just in case" scopes; incident-contact SLA of 24h.
- **Revenue share:** 80/20 in the developer's favor for paid plugins and integrations, per [Business Model](./BUSINESS_MODEL.md). Free plugins pay nothing and get the same review.
- **Enforcement ladder:** warning → delisting → grant revocation (Nova can kill-switch a plugin's tokens platform-wide within minutes) → disclosure in the transparency report for privacy violations.

## 12. Developer experience

- **Docs:** reference generated from the same OpenAPI/AsyncAPI source as the SDKs; task-oriented guides ("ground your assistant's answers in user memory in 30 minutes"); a scope-picker tool that maps features to minimal scope sets.
- **Sandbox tenant:** every developer account gets a sandbox with **synthetic context data** — a fictional user with months of realistic moments, projects, and memory, so integrations are built and demoed without ever touching real user context. Test keys (`nova_sk_test_…`) cannot reach production data, structurally.
- **Mock mode:** `new NovaClient({ mock: true })` runs fully local against the synthetic dataset with deterministic fixtures — unit tests need no network and no account.
- **CLI:** `nova` — login, key management, `nova events tail` (live event stream), `nova webhooks replay <delivery_id>`, `nova plugin dev` (local plugin runner against the sandbox), `nova scopes explain <scope>`.
- **Versioning & deprecation:** `/v1` is stable; additive changes (new optional fields, new endpoints, new event types) are not breaking, and clients must tolerate unknown fields. Breaking changes ship as `/v2` alongside `/v1`, with a **12-month minimum deprecation window**, dated sunset headers (`Deprecation`, `Sunset`), migration guides, and proactive email to every key that touched the deprecated surface in the trailing 90 days. Platform GA timing is in the [Roadmap](./ROADMAP.md); design partners build against API v0 (same shape, explicitly unstable, breaking changes with 30 days' notice) at the 6-month milestone.
