# Security, Privacy & Governance

**Why this document:** Nova sees what the user sees. That sentence is either the foundation of the most trusted product category of the next decade or the epitaph of a company that got it wrong once. Everything else in this repository — the [Product Vision](./PRODUCT_VISION.md), the [API surface](./API_AND_SDK_SPEC.md), the [Business Model](./BUSINESS_MODEL.md) — assumes users will grant Nova visibility they grant nothing else. This document specifies how we earn and keep that grant: the threat model we design against, the technical controls, the honest tradeoffs we have not yet solved, and the governance that keeps us honest when incentives shift. Where a control is aspirational rather than shipped, we say so explicitly.

## 1. Threat model

We enumerate adversaries first, because controls chosen without a threat model are theater.

### 1.1 Assets, in order of blast radius

| Asset | What it is | Why it's the target |
|---|---|---|
| Context Moments | Screen frames, transcripts, OCR/DOM extracts, intent utterances | The most sensitive corpus a user has ever handed a company — it contains *other people's* messages, documents, and faces, not just the user's own data |
| Memory | Distilled, indexed, cross-referenced knowledge: projects, relationships, semantic and long-term layers | Individually less raw than moments; in aggregate *more* revealing, because it is pre-summarized and pre-connected — a breach here needs no analysis step |
| Credentials & integration tokens | Nova's OAuth tokens for Notion, GitHub, Google, calendars, etc. | Compromise converts a Nova breach into a breach of every connected system the user has linked |

Secondary assets: consent receipts and audit logs (integrity targets — an attacker who can edit these can hide), and Nova's signing/KMS keys.

### 1.2 Adversaries and design responses

| Adversary | Capability | Design response |
|---|---|---|
| Device thief | Physical access to a locked or unlocked device | Local cache (SQLite) encrypted with OS-keystore-backed keys; Context Buffer in RAM/encrypted temp, auto-purged; app-level lock on memory review; remote sign-out revokes device keys and refresh tokens |
| Malicious app on the same device | Reads app storage, screen-records, abuses accessibility APIs | OS sandboxing is the primary control — honesty: on a rooted or fully compromised device we cannot win, and we say so; our contribution is no plaintext secrets at rest and capture indicators other apps cannot suppress on non-rooted devices |
| Network attacker | Intercepts, replays, MITMs traffic | TLS 1.3 only; certificate pinning in first-party clients; HSTS preload; webhook HMAC signatures with a 5-minute replay window; access tokens too short-lived to be worth stealing off the wire |
| Malicious third-party integration | Holds legitimately user-granted scopes; tries to exceed, hoard, or abuse them | Least-privilege scopes enforced at the query layer, not in application code; third parties never receive raw frames or audio ([API & SDK Spec](./API_AND_SDK_SPEC.md)); every access emits a user-visible audit event; platform-wide kill-switch revocation in minutes; marketplace review before and after listing |
| Compromised Nova insider | Production access; wants user content | No standing admin access to content (§5); support tooling is metadata-only; break-glass requires user consent, dual control, and tamper-evident logging; per-user encryption keys make bulk reads an anomalous, alarmed KMS pattern rather than one quiet `SELECT` |
| Legal compulsion | Subpoena, court order, national security letter | Data minimization shrinks what exists to produce; client-side-encrypted media is producible only as ciphertext; transparency report discloses request volumes; we commit to challenging overbroad requests and notifying affected users where legally permitted |
| **Nova-the-company-under-bad-incentives** | Future leadership, an acquirer, or a desperate quarter decides user context is a revenue source | The most important adversary, because it is the most probable. See §1.3. |

### 1.3 Designing against ourselves

The last adversary gets its own section because most privacy failures in this industry were not hacks; they were pivots. Our response is to make betrayal **expensive and loud**:

- **Contractual:** no-ads / no-data-sale / no-training-without-opt-in are written into customer-facing terms (§12), so violating them is breach of contract, not just breach of trust.
- **Architectural:** user-held keys for media blobs mean monetizing content requires shipping *visible client changes* users can refuse to install. There is no server-side toggle that quietly widens access.
- **Observable:** the user-visible audit log (§6) means new access patterns surface to the people being accessed. Employees would have to build a bypass — conspicuous engineering work that other employees would see in review.
- **Exitable:** full export and hard erasure are always available (§10), so leaving is cheap, and the credible threat of mass exit is the standing deterrent.

Any betrayal must require work that employees would notice, users would detect, and contracts would punish. That is what a promise looks like when it is designed to survive the people who made it.

### 1.4 Explicitly out of scope

Stated rather than hidden: a fully compromised client device or OS; a user who grants a malicious third party broad scopes despite clear, specific consent screens (we mitigate with review and fast revocation; we cannot prevent); coercion of the user themselves; side channels in third-party model providers beyond our contractual and routing controls ([Intelligence Engine](./INTELLIGENCE_ENGINE.md) routes sensitive tiers to stricter providers or local models).

## 2. Zero Trust architecture

No implicit trust between components, including our own.

- **Every service-to-service call is authenticated and scoped.** API, workers, and the realtime gateway authenticate to each other with short-lived workload identities (SPIFFE-style service tokens), not shared secrets or network position. Being "inside the VPC" grants nothing.
- **Per-user data isolation is enforced at the query layer.** Postgres row-level security (RLS) on every table containing user data, keyed on the authenticated user/grant context set per connection. Application code *cannot* forget a `WHERE user_id =` clause, because the database enforces it beneath the ORM. Cost: RLS complicates batch jobs and adds planner overhead; we accept it because "a developer forgot a filter" is a stupid way to have the worst breach in the category.
- **Scopes are evaluated server-side on every request** — never trusted from the client, never inferred from token possession alone. Token exchange re-validates the underlying user grant on every exchange, so revocation propagates in minutes, not at token expiry.
- **No unaudited access path.** First-party clients use the same `/v1` API, the same scope checks, and the same audit pipeline as third parties. There is no internal "god endpoint," and we will not add one for debugging convenience — that is what break-glass (§5) is for.
- **Secrets and keys:** KMS-managed, rotated, never in environment files in production, never in code. Integration tokens (the third asset class in §1.1) are envelope-encrypted per user and decrypted only inside the action-executor path that needs them.

## 3. Encryption — including the tradeoff we will not hide

### 3.1 In transit

TLS 1.3 everywhere: client-to-edge, edge-to-service, service-to-service (mTLS / mesh). No TLS 1.2 fallback on first-party endpoints. First-party clients pin certificates.

### 3.2 At rest — key hierarchy

```text
KMS root key (HSM-backed, access-alarmed)
 └── per-user master key (KMS-wrapped, rotation supported)
      ├── content data keys      → high-sensitivity DB columns
      │                            (transcripts, extracts, utterances)
      ├── media keys (user-held) → object-storage blobs (frames, audio),
      │                            encrypted CLIENT-SIDE before upload
      └── integration-token keys → third-party OAuth tokens
```

- **Postgres:** encrypted volumes as the floor; per-user envelope encryption for high-sensitivity columns. Per-user keys make cross-user bulk reads an anomalous, loggable KMS access pattern — exfiltrating a million users' transcripts requires a million alarmed key operations, not one query.
- **Object storage (media):** client-side encryption with user-held keys where feasible. The capture client encrypts blobs before upload; once the enrichment window closes, Nova stores ciphertext it cannot open without the user's key material.
- **On device:** SQLite cache and queue encrypted with OS-keystore-backed keys; the Context Buffer never touches disk unencrypted.

### 3.3 The honest tradeoff

Full end-to-end encryption conflicts with what Nova is for. Server-side enrichment — OCR cleanup, entity extraction, embedding, semantic search — requires processing plaintext. Under true E2EE, the cloud could do none of it, and Nova would be an encrypted screenshot bucket. So the MVP posture, stated plainly:

> **MVP: the server processes plaintext transiently, in memory, during enrichment. It persists encrypted. Plaintext is never written to disk outside the enrichment pipeline, never logged, never retained after pipeline exit. This is a real trust boundary — users are trusting our runtime, not just our storage — and we document it instead of implying E2EE we do not have.**

Roadmap, in order:

1. **User-key envelope encryption for all persisted content** — storage breaches and subpoenas yield ciphertext; key revocation becomes user-controlled.
2. **Local-only enrichment** — on-device OCR/embedding matured to the point that raw media need not reach the server at all on supported platforms, eliminating the transient-plaintext window for those flows.

We will not market step 2 before it ships, and any marketing that says "encrypted" will say encrypted *how*.

### 3.4 Third-party model providers

Enrichment and reasoning route through external model providers (Anthropic, OpenAI, Google) when cloud inference is used — which makes providers part of the trust boundary, not a footnote:

- Providers are **named subprocessors** in the DPA (§10), engaged under zero-retention / no-training API terms only. A provider that will not contract for zero retention does not receive user context, whatever its benchmark scores.
- The [Intelligence Engine](./INTELLIGENCE_ENGINE.md) routes by **privacy tier** as a first-class input alongside cost and latency: local-only projects never reach cloud providers; sensitive-tier content routes to the strictest contracted provider or to local models; users and enterprise admins can pin tiers.
- Requests to providers carry the minimum context needed for the task — enrichment prompts are built from the moment being processed, not from the user's broader memory — and provider calls are logged (identifiers and byte counts, never payloads) so "what left, to whom" is answerable per user.
- Residual risk, stated honestly: we rely on contractual and architectural controls, not cryptographic ones, for data inside a provider's inference window. This is the same transient-plaintext class of trust as §3.3, extended to a vendor, and the local-enrichment roadmap shrinks it over time.

### 3.5 Data lifecycle at a glance

| Stage | Where | Protection |
|---|---|---|
| Perception & buffering | On device | Context Buffer in RAM/encrypted temp; auto-purge; nothing transmitted |
| Capture (on invocation) | Device → edge | Client-side encryption of media; TLS 1.3 + pinning; redaction pipeline before persistence |
| Enrichment | Server memory (or device, on the roadmap) | Transient plaintext, in-memory only, never logged, freed at pipeline exit (§3.3); provider calls per §3.4 |
| Storage | Postgres / object storage | Per-user envelope encryption; user-held keys for media; RLS isolation |
| Retrieval | API → granted clients | Scope checks per request; provenance attached; audit event emitted |
| Aging & deletion | Storage | Retention schedules; hard delete incl. embeddings and edges; backups expire ≤ 35 days |

## 4. Local-first processing — what never leaves the device

Per [System Architecture](./SYSTEM_ARCHITECTURE.md) and [Context Buffer](./CONTEXT_BUFFER.md):

| Never leaves the device | Detail |
|---|---|
| The Context Buffer | Rolling buffer (default 60s, max 5 min), RAM/encrypted temp only, auto-purged, **never uploaded wholesale**. Only the slice the user explicitly promotes into a Context Moment is transmitted |
| Local-only projects | Users pin projects to local-only: their moments, enrichment (degraded to on-device capability), and search never touch Nova cloud. Tradeoff: weaker enrichment, no cross-device sync for those projects — the user chooses |
| Raw frames beyond the enrichment window | Today: uploaded frames are client-side encrypted, and §3.3's transient-plaintext rule bounds server handling. Endgame: local enrichment processes and discards raw frames on device |
| Anything captured while capture is off | Trivially true and worth stating: there is no background telemetry of screen content, no "quality sampling," no exceptions |

**No always-on recording, ever.** Capture happens on invocation; live sessions are explicitly started, visibly indicated, bounded (30-minute hard cap), and explicitly ended. This is simultaneously an ethical commitment, a legal necessity (wiretap and all-party-consent statutes), and platform-policy survival (App Store and Play Store reject covert recording) — see [Risks & Red Team](./RISKS_AND_RED_TEAM.md).

## 5. Access control

**Externally:** OAuth 2.1 + PKCE for users, scoped API keys (+ optional mTLS) for services, RFC 8693 token exchange for assistants acting for users, per-project scope grants — all specified in [API & SDK Spec](./API_AND_SDK_SPEC.md), all enforced at the RLS layer described in §2.

**Internally:** RBAC with roles that map to jobs, not seniority. The load-bearing rule:

> **No Nova employee has standing access to user content. None. Not the CEO, not on-call, not "senior infra."**

- **Support tooling operates on metadata only:** account state, plan, error traces, webhook delivery logs, audit summaries. Support can see *that* a moment failed enrichment — never what it contained.
- **Break-glass** exists for the rare case where debugging requires content, and it requires all of: (a) the affected user's explicit, per-incident consent via an in-product prompt that names who is asking and why; (b) two-person authorization; (c) a time-boxed grant measured in hours; (d) an entry in the user's own audit log and in the transparency-report counter (§12). If the user declines, we debug blind or refund. That is the deal.
- Production infrastructure access (not content) requires SSO with hardware-key MFA, short-lived credentials, and session recording. Access reviews quarterly.

## 6. Audit logs

- **Append-only and user-visible.** Every content access, every third-party query, every action proposal/approval/execution, every grant change, every break-glass event becomes an audit entry. Users browse their own log in-product, filterable by party, scope, and time; third-party access also streams in real time as `audit.third_party_access` events ([API & SDK Spec](./API_AND_SDK_SPEC.md)).
- **Tamper-evident hash chain.** Each entry commits to the hash of its predecessor:

```json
{
  "id": "aud_01J9Y2…",
  "ts": "2026-07-09T14:31:07Z",
  "actor": { "type": "third_party", "party": "dona", "grant_id": "grt_01J8…" },
  "verb": "memory.query",
  "scope": "memory:search",
  "target": { "project_id": "prj_01J8…", "result_count": 4 },
  "prev_hash": "b1946ac9…",
  "hash": "5d41402a…"
}
```

  Chain-head checkpoints are periodically written to independent storage — and, for enterprise tenants, to the customer's own storage. Consequence: we cannot silently rewrite history, and neither can an attacker with database access; the log can be destroyed (detectable) but not edited (undetectable).
- **No content payloads in logs.** Audit entries, structured service logs, and OpenTelemetry traces record identifiers, scopes, parties, timestamps — never context content. This is lint-enforced on log call sites, not just policy.

## 7. User consent — layered, not bundled

One install screen that "agrees to everything" is how the industry got here. Nova's consent is layered; each layer is separate, revocable, and honestly worded:

| Layer | Grants | Does NOT grant |
|---|---|---|
| Install | Running the app/extension, account, settings | Any capture at all |
| Capture (Instant Capture Mode) | Capture on explicit invocation only | Audio, buffering, live sessions |
| Audio / voice | Push-to-talk transcription during invocation; MVP uses cloud ASR and the consent screen says so | Ambient listening; wake word is a separate later opt-in |
| Context Buffer | The bounded local rolling buffer, while the user keeps it enabled | Uploading the buffer; anything after the user disables it |
| Live Context Mode | Explicitly started, visibly indicated, bounded sessions | Background observation; sessions the user did not start |
| Third-party grants | A named party, named scopes, named projects | Any other party, scope, or project |

Mechanics:

- Each layer has its own consent moment: plain-language description of what is collected, where it is processed (device vs cloud), retention, and how to revoke. Reading level: a stressed person skimming, not a lawyer.
- **Consent receipts are stored and exportable:**

```json
{
  "receipt_id": "cns_01J9…",
  "granted_at": "2026-07-09T09:02:44Z",
  "layer": "third_party_grant",
  "party": "dona",
  "scopes": ["memory:read", "memory:search"],
  "projects": ["prj_01J8…"],
  "consent_text_version": "2026-06-01.en",
  "revoked_at": null
}
```

  "What did I agree to, and when, and in what words" always has an answer.
- Revocation is immediate at the API boundary and one screen deep — never buried, never "email support."
- In Live Context Mode with meeting audio, Nova displays a recording-consent reminder: all-party-consent compliance is the user's legal obligation, and we say so rather than pretending the problem away.

## 8. Data minimization

- **Capture only on invocation.** No passive accumulation, no "we kept it in case it's useful." The corpus is what the user chose to keep, not what they happened to see.
- **Auto-redaction pipeline before storage.** Every frame and text extract passes through detectors *before* persistence:

  1. **Regex tier** (deterministic): payment card PANs with Luhn validation, SSN patterns, API-key shapes (`AKIA…`, `sk-…`, `ghp_…`, `xoxb-…`), `BEGIN PRIVATE KEY` blocks, IBANs.
  2. **ML tier** (probabilistic): password-manager overlays, credential dialogs, 2FA code screens, secret-shaped visual regions the regexes cannot see.
  3. **Masking:** detected regions are blacked out in stored frames and elided in stored text; the moment records that a redaction of kind X occurred — never the redacted content itself.

  False positives are user-correctable from the original on-device capture within the enrichment window — except for credentials, which are not recoverable by design (§9). Honesty: no detector is perfect. This pipeline reduces, not eliminates, accidental secret persistence; layered with denylists and secure-field exclusion it makes the common failure modes rare.
- **Configurable denylist.** Domains and apps where invocation is refused before a single frame is taken. Banking sites and password managers ship on the default list; users can extend it; enterprise admins can force-extend it.
- **OS-level secure fields excluded.** Password inputs flagged by the platform (`type=password`, secure text entry) are excluded via OS mechanisms where available; the redaction pipeline is the backstop where they are not.
- **Retention defaults against hoarding.** Raw frames age out to summaries + extracts on a user-configurable schedule (including "keep forever" and "purge raw after N days"); the Memory Engine's forgetting mechanics apply on top ([Memory Engine](./MEMORY_ENGINE.md)).

## 9. Sensitive-data handling

Special categories get special defaults:

| Category | Default behavior | User override? |
|---|---|---|
| Credentials — passwords, 2FA codes, private keys, session cookies | Never captured; redacted irreversibly if detected | **No. Not configurable.** There is no legitimate reason for Nova to store a password, and "the user asked" is how breach headlines start |
| Financial — banking apps/sites, PANs, account numbers | Banking domains on the default denylist; PAN/account patterns redacted | Partial: a user may remove a *site* from the denylist (say, the fintech they work at); PAN redaction stays on |
| Health | Not auto-blocked as a category in MVP — detection is unreliable and blocking is paternalistic; users can denylist health portals; enterprise admins can force category denylists | Yes |
| Other people's messages and content | Captured only when on-screen during a user invocation; used only within that user's own memory; any redistribution via actions is Tier 2 (explicit per-instance approval); relationship memory is deletable per person | Governed by action tiers, not a toggle |
| Government identifiers (SSN, etc.) | Pattern-redacted before storage | No for SSN; regional ID patterns expand over time |

The asymmetry is deliberate: users may accept risk *about themselves* (their health, their finances), but cannot opt Nova into storing credentials — credential compromise is never contained to the person who accepted the risk.

## 10. Enterprise compliance

| Obligation | Commitment |
|---|---|
| SOC 2 | Controls designed to SOC 2 from day one (access reviews, change management, vendor management). Type I audit before enterprise sales conversations; Type II within 12 months of first enterprise deployment. We will not say "SOC 2 compliant" before the report exists |
| GDPR — access/export | Full machine-readable takeout: moments, memory, audit log, consent receipts. Self-serve, so the 30-day SLA is usually minutes |
| GDPR — erasure | Hard delete of content, embeddings, and graph edges; backups age out within 35 days; deletion is confirmed to the user when complete, including backup expiry date |
| GDPR — accountability | Records of processing maintained; DPIA required for every capture-touching feature (§12); EU SCCs where applicable |
| CCPA/CPRA | Same rights surface. "Do not sell or share": structural, not a toggle — there is no sale or sharing to opt out of |
| DPA | Standard data-processing agreement at Teams tier and above, including the named subprocessor list (model providers are subprocessors when cloud inference is used, with regional options) and breach terms matching §11 |
| Data residency | EU/US region pinning from the Teams tier |
| Self-host / VPC | Enterprises can run the full backend in their own VPC or on-prem ([Business Model](./BUSINESS_MODEL.md)). Nova cloud then never holds their content — the ultimate compliance answer, and the ultimate proof that the architecture works without us holding the data |

## 11. Incident response

**Severity levels:**

| Level | Definition | Example |
|---|---|---|
| SEV-1 | Confirmed unauthorized access to user content or integration credentials | Third party exceeded scope enforcement; storage breach with usable keys |
| SEV-2 | Vulnerability exposing content with no confirmed access; audit-chain integrity failure | Scope-bypass bug found internally or via bounty |
| SEV-3 | Metadata exposure; availability incidents with security implications | Webhook delivery logs exposed across tenants |
| SEV-4 | Policy or process failure without exposure | Break-glass performed with incomplete paperwork |

**Notification commitments:** GDPR's 72-hour regulator deadline is the *floor*, not the target. Self-imposed: affected users notified of any SEV-1 within **24 hours** of confirmation — with what we know, what we do not yet know, and what they should do — not after legal review has sanded the language into meaninglessness. SEV-2 disclosed to affected users within 7 days of mitigation.

**Post-incident public writeups** for every SEV-1 and SEV-2: timeline, root cause, user impact, remediation. Published in full, not summarized. This category's trust deficit is too deep for "we take security seriously" statements.

**Readiness:** on-call rotation from alpha; quarterly drills, including a break-glass drill and a "we have been served an overbroad demand" tabletop; forensics tooling built metadata-first so investigation itself respects §5.

## 12. Governance — staying honest over time

- **Privacy review, mandatory:** any feature touching capture, memory, retention, or third-party access requires a written privacy review — data flows, minimization analysis, consent surface, threat-model delta — before implementation starts, appended to the feature's ADR ([Repo Structure](./REPO_STRUCTURE.md)). No review, no merge.
- **Internal red team:** a standing responsibility (a person now, a team as we grow) to attack Nova the way §1's adversaries would — including exfiltration attempts through the plugin sandbox, scope-bypass probing against RLS, and social-engineering the break-glass process.
- **External audits and pentests before public beta:** at minimum, one full external penetration test covering API, extension, and web app, plus a focused code audit of the capture and redaction pipelines — findings fixed or published as accepted risks *before* the public-beta milestone in the [Roadmap](./ROADMAP.md).
- **Responsible disclosure + bug bounty:** public `security.txt` and disclosure policy at alpha; paid bounty at public beta, with scope-bypass, redaction-bypass, and capture-pipeline classes at the top of the payout table.
- **Transparency report, semiannual:** government and legal requests (count, type, compliance rate); break-glass invocations (the count of exceptions to "no employee sees content" — the number the report exists to keep small); integrations removed for violations; material policy changes.
- **Data ethics commitments** — structural, contractual, and permanent, aligned with [Business Model](./BUSINESS_MODEL.md):
  - **No ads.** Nova's economics are subscriptions and metered platform usage; there is no ad model to grow into.
  - **No data sales.** Not "anonymized," not "aggregated," not to "trusted partners." None.
  - **No training on user context without explicit opt-in** — granular, revocable, off by default, never a condition of service, never smuggled in through a terms update.

  These live in customer-facing terms, so breaking them is breach of contract; the §1.3 architecture ensures breaking them quietly is impossible; and the export/erasure guarantees ensure that if we ever deserve to lose users, losing them is easy. Expensive, loud, and litigable — by design.
