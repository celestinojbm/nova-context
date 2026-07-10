# Authentication & User Isolation (M5)

How Nova Context authenticates users across the API, web app, and browser
extension, and how per-user data isolation is enforced. This documents what
is **built and tested**, not aspiration — the long-term developer-platform
design (OAuth 2.1 + PKCE + scopes for third parties) stays in
[API_AND_SDK_SPEC.md](API_AND_SDK_SPEC.md).

## The chosen approach: password login + opaque server-side sessions

For a first-party, private-alpha product with exactly three clients we own
(web app, extension, tests), the boring, auditable choice is:

- **Email + password** accounts. Passwords hashed with Node's built-in
  **scrypt** (N=2^17, r=8, p=1, per-hash salt, parameters stored in the
  hash so they can be raised later). No external auth dependency, no IdP.
- **Opaque session tokens** (256-bit random, `nova_sess_`/`nova_ext_`
  prefixed). The database stores only the SHA-256 of the token — a DB dump
  contains no usable credentials. Sessions have fixed expiry
  (`NOVA_SESSION_TTL_HOURS`, default 7 days web; 30 days extension), a
  `last_used_at` trail, and a `revoked_at` kill switch.
- **One credential shape at the API**: `Authorization: Bearer <token>`.
  The API reads **no cookies**, so cross-site request forgery has no
  ambient credential to ride on.

### Why not OAuth 2.1/PKCE now?

OAuth's value is delegating auth *across trust boundaries* (third-party
apps, external IdPs). M5 has none: every client is first-party. Standing up
an authorization server (or depending on a hosted one) would add moving
parts without adding security for this topology. The session model above is
the well-trodden "server-side session" pattern; when the developer platform
opens the API to third parties, OAuth 2.1 + PKCE + scopes layers on top of
these same `sessions`/`users` tables (the schema was built for it).
**Limitations accepted:** no SSO, no passkeys, password reset is manual
(operator resets `password_hash`) — acceptable for a private alpha, revisit
before any public beta.

## Per-surface flows

### Web app (Next.js)

- `/login` posts to a server action → `POST /v1/auth/login` → the token is
  stored in an **HttpOnly, SameSite=Lax, Secure-in-production cookie on the
  web app's origin**. Client JS can never read it.
- Every page/server action forwards the cookie value as a Bearer header
  server-side (`app/lib/api.ts`). The browser itself never calls the API.
- Middleware redirects cookie-less visitors to `/login`; any API 401
  (expired/revoked) redirects to `/login?error=expired`.
- Export downloads go through `/export`, a same-origin proxy that attaches
  the token server-side and streams the API response.
- Sign out = server action → `POST /v1/auth/logout` (revokes the session
  row) + cookie deletion.
- CSRF: Next server actions enforce same-origin; the cookie is SameSite=Lax;
  and the API accepts only Bearer headers — three independent layers.

### Browser extension (pairing flow)

The extension never sees a password. Connecting:

1. User signs in on the web app → Settings → Browser extension →
   **Generate pairing code** (`POST /v1/auth/pairing-codes`, allowed only
   for `web`-kind sessions so an extension token cannot breed credentials).
2. Code is 8 digits, stored hashed, **expires in 10 minutes, works once**
   (claimed atomically).
3. Extension submits it (`POST /v1/auth/pairing/claim`) and receives its own
   **extension-kind session token**, stored in `chrome.storage.local` — the
   only credential the extension holds. The account email is kept for
   display only.
4. Every extension request goes through `authFetch`: on any 401 the stored
   token is wiped and all UI surfaces converge on the Connect screen with a
   re-pair prompt. Disconnect (in extension settings) revokes the session
   server-side *and* forgets it locally; the web Settings page can also
   revoke any extension session remotely.

Trade-offs: a pairing code is phishable in principle (someone could ask a
user to read a code aloud) — mitigated by the 10-minute/single-use window
and by codes being mintable only from a signed-in web session. The token in
`chrome.storage.local` is readable by anything that can already read the
profile directory (same class of access as the browser's own cookies);
Chrome's `storage.session` was rejected because live-mode users expect the
pairing to survive browser restarts.

### Tests / CI

Integration suites sign in for real: M0–M4 regression files log in as the
seeded dev user; the auth/isolation suites create fresh accounts through the
public signup endpoint. Nothing bypasses the middleware.

## Authorization middleware (fail closed)

`services/api/src/auth/plugin.ts` runs on **every** `/v1` request. The only
public routes are the explicit allowlist: `POST /v1/auth/signup`,
`POST /v1/auth/login`, `POST /v1/auth/pairing/claim` (all rate-limited
in-process: 30 attempts / 15 min / IP). Everything else — including any
route added in the future — requires a live session or gets **401**.

Ownership stays in each route's SQL: every query on a user-owned table
carries `user_id = <authenticated user>`. Cross-user access returns **404**
(not 403), so resource existence never leaks. The isolation suite
(`test/integration/isolation.test.ts`) proves User B cannot read, list,
search, export, delete, complete, approve, or reject anything of User A's —
moments (instant and live-saved), projects, tasks, actions, audit rows,
sessions, product events, embeddings.

## Database changes (`migrations/0005_m5_auth.sql`)

- `users.password_hash text` (NULL = cannot log in).
- `sessions` (id, user_id, `token_hash` unique, kind `web|extension`,
  created/expires/last_used/revoked timestamps, label).
- `pairing_codes` (id, user_id, `code_hash` unique, expiry, claimed_at).

**Migration behavior for existing data:** nothing is rewritten. All M0–M4
rows already carry the seeded dev user's `user_id`; that account simply
became a normal account with no password. To keep using that data locally,
run `pnpm --filter @nova/api db:seed-dev` (sets a password for
`dev@nova.local`; refuses to run when `NODE_ENV=production`) and sign in as
`dev@nova.local` / `nova-dev-password` (override via `NOVA_DEV_PASSWORD`).

## Environment variables

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `NOVA_SIGNUP` | api | `open` (dev) / `invite` (prod) | `open` \| `invite` \| `closed` |
| `NOVA_ALPHA_INVITE_CODE` | api | unset | Required by `invite` mode; in production, missing code ⇒ signup fails closed |
| `NOVA_SESSION_TTL_HOURS` | api | 168 | Web session lifetime |
| `NOVA_EXTENSION_SESSION_TTL_HOURS` | api | 720 | Extension session lifetime |
| `NODE_ENV` | api, web | — | `production` switches signup default to invite-only and marks the web cookie `Secure` |
| `NOVA_DEV_PASSWORD` | api (script) | `nova-dev-password` | Password set by `db:seed-dev` |
| `NOVA_ENCRYPTION_KEY` | api, worker | unset | 32-byte key (hex/base64) for integration tokens at rest; required for Notion; fail-closed |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` / `NOTION_REDIRECT_URI` | api | unset | Notion OAuth app; redirect URI = web app `/integrations/notion/callback` |
| `NOVA_ACTION_QUEUE` | api, worker | `action-execution` | Queue carrying approved external actions |
| `NOVA_IMAGE_REDACTION` | api | `on` | M7 OCR-box masking of screenshots/frames before storage/live/export |
| `NOVA_SCREENSHOT_STORAGE` | api | `on` | M7 kill switch — `off` strips all image payloads server-side |
| `NOVA_OCR_LANG_PATH` / `NOVA_OCR_TIMEOUT_MS` | api | CDN / 10000 | Tesseract language data location; per-image OCR budget |
| `NOVA_RATE_LIMIT_MAX` / `NOVA_RATE_LIMIT_PREFIX` | api | 30 / `nova:ratelimit` | Credential-surface rate limit (Redis-shared when REDIS_URL set) |
| `NOVA_RESET_EMAIL` / `NOVA_RESET_PASSWORD` | api (script) | — | Operator password reset (`auth:reset-password`) |
| ~~`NOVA_API_TOKEN`~~ | — | **removed** | The M0 shared token is gone from API, web, and extension |

Development vs production, concretely: dev = open signup, non-Secure
cookie on localhost, `db:seed-dev` available. Production = invite-only by
default, Secure cookie, seed script refuses to run, no dev-user fallback
anywhere in runtime code (grep `dev@nova.local` — it appears only in the
seed migration, the seed script, and tests).

## Auditing

New payload-free audit events: `auth.signup`, `auth.login`, `auth.logout`,
`auth.session.revoke`, `auth.extension.paired`. Tokens, codes, and password
material never appear in the audit log (asserted in the auth suite).

## Visual Redaction v1 (M7 — implemented)

Screenshots and live-session frames are **OCR-box masked before storage** —
and therefore before enrichment, search, export, live Q&A, and any external
adapter, all of which read only stored (already-masked) payloads.

**How.** An on-process Tesseract engine (`tesseract.js`, no cloud call —
pixels never leave the API) produces word bounding boxes; the SAME detectors
that redact captured text (emails, phones, Luhn-valid cards, API keys/JWTs,
SSNs, IBANs) classify the OCR'd lines, plus two image-specific conservative
heuristics: labeled one-time codes ("code/OTP/PIN … 123456") and street
addresses (number + capitalized name + street suffix). Matched words are
painted over with opaque black rectangles (jimp, pure JS) and the image is
re-encoded. The moment stores a values-free report
(`context_moments.image_redaction`: state + counts by type), which also
lands in the capture audit event.

**Fail-safes.**
- Capture, strict mode (per-user extension setting, enforced server-side):
  OCR failure/timeout ⇒ the image is DROPPED (`blocked_strict`).
- Capture, non-strict: image kept, state honestly `failed`.
- `NOVA_SCREENSHOT_STORAGE=off` (server kill switch): every image stripped
  before storage (`storage_disabled`).
- Live Q&A: a frame that cannot be masked is DROPPED — unredacted pixels
  never reach the model, no setting can weaken that.
- `NOVA_IMAGE_REDACTION=off`: state `skipped` (documented, visible in audit).

**Client-side settings** (M4, unchanged): text-only mode (no screenshot
leaves the device), blur-before-store, plus M7's strict toggle.

**Limitations (honest).** OCR-box masking only masks text Tesseract can
read: stylized fonts, tiny text, rotated content, or non-text sensitive
pixels (faces, QR codes) are not detected. Blur/text-only modes remain the
belt-and-braces for high-risk screens. The real-OCR path is proven by a
gated e2e test (`NOVA_OCR_E2E=1`) that renders sensitive text, masks it,
and re-OCRs to confirm removal; CI uses deterministic fake engines.

## Auth hardening (M7)

- `POST /v1/auth/password` (web sessions only, rate-limited): verifies the
  current password, swaps the scrypt hash, and **revokes every other
  session** — web and extension. Old credentials and stolen sessions die
  together.
- `POST /v1/auth/sessions/revoke-all`: signs out everything except the
  current session (panic button in Settings).
- Operator reset: `NOVA_RESET_EMAIL=... NOVA_RESET_PASSWORD=... pnpm
  --filter @nova/api auth:reset-password` — sets the hash and revokes ALL
  sessions; the documented recovery path (no self-service reset in alpha).
- Rate limiting is **Redis-backed** when `REDIS_URL` is set (fixed window
  shared across instances, `NOVA_RATE_LIMIT_MAX` per 15 min per IP); the M5
  in-memory limiter remains the single-instance fallback. Redis errors fail
  open (availability over lockout — documented trade-off).
- Production checks at boot: Notion redirect URI must be `https://`;
  `NOTION_CLIENT_ID` without `NOVA_ENCRYPTION_KEY` refuses to start; a
  one-line `[security]` posture summary is logged.

## Notion integration (M6 — implemented)

Notion is the first Tier-1 external adapter, executed only through
approved, auditable, per-user jobs.

**Connect flow.** Web Settings → "Connect Notion" → the API mints a
single-use `state` (random 256-bit, stored as SHA-256, bound to the
initiating user, 10-minute TTL) and returns Notion's authorize URL; the
browser is redirected there. Notion redirects to the WEB APP callback
(`/integrations/notion/callback`), which relays `code`+`state` to the API.
The API claims the state atomically (unknown / expired / replayed /
another user's state → 400), exchanges the code (client secret never
leaves the API), and upserts the connection. PKCE is not offered by
Notion's integration OAuth; the single-use user-bound state is the CSRF
defense. Only `web`-kind sessions can start or complete the flow — the
extension has no OAuth surface at all.

**Token encryption.** `NOVA_ENCRYPTION_KEY` (32 bytes) drives AES-256-GCM
(`@nova/context-engine/secret-box`, layout `[ver][iv][tag][ct]`, random
nonce per encryption, tamper-detecting). Tokens exist ONLY as ciphertext
in `integration_connections.token_ciphertext`. Missing key ⇒ integration
endpoints answer 503 and worker execution fails closed; in production,
`NOTION_CLIENT_ID` without the key refuses to boot. Disconnect revokes the
row AND overwrites the ciphertext with an empty value.

**Job-based execution.** Approving an external action no longer executes
inline. The approve endpoint verifies an active per-user connection
(otherwise 409 `notion_not_connected` and the action stays `proposed`),
atomically transitions `proposed → queued`, audits
`action.approve`+`action.queued`, and enqueues a BullMQ job whose id IS
the action id (duplicate enqueue collapses). The worker claims
`queued → executing` (audited), loads the OWNER's connection, decrypts,
composes the page with the same builder the preview used, creates it, and
completes `executing → done` storing the external page id in the same
statement (audited as `action.execute` with `external_id`). Transient
provider errors (429/5xx/network) retry up to 3 times with backoff; a
stored external id short-circuits any retry/redelivery so no duplicate
pages are created. Terminal problems (no/revoked connection, undecryptable
token, provider 4xx, no shared page) mark the action `failed` (audited)
and stop retrying. `nova_task` (internal, Tier-0) still executes inline.

**Preview.** `GET /v1/actions/:id/preview` returns the destination
workspace, source URL/host, linked moment, the user's instruction, tags,
and the EXACT sections the worker will write — the approval card renders
this, and the user must explicitly approve. Captured content remains data:
page content is quoted, never interpreted, and screenshots are never
uploaded.

**Destination selector (M7).** `GET /v1/integrations/notion/destinations`
lists the pages/databases the user shared with the integration (Notion has
no "list all" API — `/v1/search` over shared objects IS the safe selector:
the user controls the candidate set inside Notion). The user saves a
per-user default (`PUT /v1/integrations/notion/destination`, stored in
their own `integration_connections.meta`); the approval card shows it, and
the approve endpoint accepts a validated per-action override. Execution
resolves: approval override → saved default → most recently edited shared
page.

**Content (M7 hardening).** Pages carry summary, the user's instruction,
source metadata (title — URL — captured-at), a captured-text excerpt, tags,
a Privacy section (text + image redaction states, masked-region count, and
the explicit no-screenshot policy), and a footer referencing the Nova
moment id and action id (audit cross-reference). **Screenshots are never
uploaded to Notion**: embeds require a publicly hosted URL and Nova does
not host captured pixels — hosting them would trade a privacy guarantee
for a convenience. Documented limitation rather than a hidden toggle.

**Known limitations (documented, not hidden).** If the worker crashes in
the window between the Notion create call and the DB write, a retry could
produce a duplicate page (Notion has no idempotency keys); the window is
one statement wide. Notion tokens don't expire but can be revoked
workspace-side — that surfaces as a terminal 4xx failure on the next
execution. A saved destination the user later un-shares fails the action
with a clear provider error.

## Media pipeline (M8 — implemented)

Screenshots and live frames no longer live inside `context_moments.payload`
JSONB. `moment_media` is the source of truth for captured pixels; blobs are
encrypted and written to object storage; the payload keeps everything else.

**Pipeline order (unchanged, enforced in code).** capture → text redaction
→ visual redaction (M7 OCR-box masking) → media encryption + object
storage → DB reference (`moment_media` row) → enrichment / search / export
/ adapters. Redaction always happens BEFORE bytes touch storage; nothing
downstream ever sees unmasked pixels. M7's fail-safes carry over intact:
strict-mode redaction failure blocks the image (`blocked_strict`),
`NOVA_SCREENSHOT_STORAGE=off` strips it (`storage_disabled`), and live
frames that fail redaction are dropped, all before the storage step.

**Object storage abstraction.** A three-method `ObjectStore` interface
(`put`/`get`/`delete`) with two implementations: `FsObjectStore` (default,
`NOVA_MEDIA_FS_ROOT`, local-first — no external service needed) and
`S3ObjectStore` (any S3-compatible endpoint: AWS S3, MinIO, Cloudflare R2;
`forcePathStyle` for MinIO). No provider-specific behavior leaks past the
interface, so swapping backends is an env change. `infra/docker-compose.dev.yml`
ships an optional MinIO under the `media-s3` profile.

**Encryption at rest.** Every blob (full image and thumbnail) is sealed
with AES-256-GCM (`@nova/context-engine/secret-box` byte API, same
`NOVA_ENCRYPTION_KEY` and `[ver][iv][tag][ct]` layout as integration
tokens, random nonce per blob). The object store NEVER sees plaintext —
encryption happens in the API process, so a compromised bucket or disk
yields ciphertext only. Fail-closed: without the key the media pipeline is
unavailable — capture still succeeds but images are DROPPED (state
`media_unavailable`), never stored unencrypted; `/v1/media/*` answers 503;
production refuses to boot without the key at all.
*Key rotation strategy:* the leading version byte is the rotation hook.
Rotation = introduce key v2, decrypt-with-v1/re-encrypt-with-v2 over
`moment_media.storage_key` rows (an offline sweep like the backfill
command), bump the version byte per blob as it is rewritten, drop v1 when
no rows remain. Documented here as the strategy; the sweep tool ships when
a second key exists.

**Media access.** `GET /v1/media/:id?variant=full|thumb` is the ONLY read
path: authenticated, strictly user-scoped (someone else's id and an
unknown id are the same 404), and PROXIED — the API decrypts per request
and streams the bytes with `cache-control: private`. No public objects, no
signed URLs: nothing can outlive a session, be forwarded, or bypass a
future revocation. Thumbnails (≤320px, generated at capture, encrypted the
same way) keep the timeline light. Deleting a moment (or a project with
its moments) deletes the blobs from object storage in the same operation
and audits the object count; export (`format_version` 2) inlines decrypted
media as data URLs so the user's export remains complete and portable.

**Search over media (M8 quality pass).** Visual redaction already OCRs
every image, so the NON-masked words (sensitive boxes excluded) are kept
as `context_moments.ocr_text` and indexed into the existing tsvector at
weight C. Screenshots become findable by their visible safe text without
any new privacy surface — masked content never reaches the index. Search
gains two filters: `has_media` and `image_redaction_state`. A golden
fixture suite pins expected top hits, media-derived retrieval, and filter
behavior.

**Legacy backfill (manual, safe).** Pre-M8 rows with inline
`data:image/*` payloads are migrated by the operator command
`pnpm --filter @nova/api media:backfill` (idempotent, audited as
`media.backfill`). Policy: rows whose `image_redaction.state` is
`applied` were provably masked at capture and move as-is; anything else is
re-redacted NOW and only the masked output is stored — if OCR is off or
fails, the row is SKIPPED and left exactly as it was. Unredacted legacy
pixels can never reach object storage; re-run after fixing OCR to pick up
strays.

**Notion media (deferred to M9 — interface ready).** The media pipeline
now exposes everything a future Notion upload needs (per-media redaction
state, decrypted export access, stable ids); actually uploading
screenshots to Notion remains OUT — M7's no-screenshot policy stands until
M9 designs explicit per-action consent for it.

**Known limitations.** Blob writes are not transactional with the DB row —
a crash mid-store can orphan a blob (never the reverse: the row is written
after the bytes land); M9's `media:cleanup` command removes such orphans.
Media failures at capture never fail the capture itself (the moment is
stored without media). The fs backend has no built-in replication —
production should prefer the s3 backend.

## Media operations (M9 — implemented)

M8 built the pipeline; M9 makes it operable before captured media ever
flows to external tools.

**Orphan cleanup (`media:cleanup`).** Blobs can exist without a
`moment_media` row (crash between the blob write and the DB insert). The
manual command lists object storage, diffs against EVERY user's
`moment_media` keys (so deleting valid media is structurally impossible),
and removes the orphans. Dry-run is the default; `--delete` opts in; blobs
younger than `--min-age-minutes` (default 60) are never touched because an
in-flight capture writes its blob before its row. Deletions are audited
per affected user as `media.cleanup` with counts only. The command handles
opaque ciphertext keys — it needs no encryption key and sees no pixels.

**Delete hardening.** A user's delete (moment or project) now NEVER fails
or silently leaks because object storage hiccuped: each blob delete that
fails is tombstoned into `media_delete_queue` (UNIQUE per key; repeated
failures bump `attempts`), the delete succeeds, and the audit records
`deleted_media_objects` + `queued_media_deletions`. `media:cleanup` drains
the queue on every run (the retry/recovery path), and the per-user storage
usage surfaces `pending_deletions` so a stuck queue is visible, not
invisible.

**Storage accounting.** `GET /v1/media/usage` (authenticated, strictly
user-scoped) returns aggregates only: object count, encrypted bytes,
thumbnail bytes, per kind, per redaction state, per project, plus pending
deletions. The web Settings page renders it. No keys, no content, ever.

**Media access audit policy (decided + documented).**
- *Exports* — always audited (`export` event, media object counts).
- *Deletes* — always audited (`moment.delete` / `project.delete` with
  media counts; cleanup as `media.cleanup`).
- *External adapter access* — always audited (`media.adapter_access`) and
  gated: `MediaService.getForAdapter` is the ONLY adapter-facing read and
  refuses media whose visual redaction is not provably `applied` unless
  the user's explicit override is passed. No adapter currently calls it —
  Notion upload is an M10 consent decision.
- *Direct views* (timeline thumbnails, full view) — NOT audited by
  default, same policy as reading a moment; `NOVA_MEDIA_VIEW_AUDIT=on`
  enables per-view rows (`media.view`, id + variant only) for deployments
  that want the noise.

**Key rotation v0 (`media:rotate-key`).** Re-encrypts every media blob
(full + thumbnail) AND every active integration token from
`NOVA_ENCRYPTION_KEY_OLD` to `NOVA_ENCRYPTION_KEY`. Dry-run default,
`--apply` to write. Resumable by construction: each item is first tried
with the new key and skipped if it already opens, so an interrupted run
continues where it stopped and reruns are no-ops. Items neither key opens
are counted, named by id (never content), left untouched, and flagged via
exit code 2. Plaintext exists only in process memory between decrypt and
re-encrypt. *Limitations (documented):* the rotation is offline — run it,
verify `undecryptable: 0`, then redeploy API+worker with the new key
(until the flip, already-rotated blobs are unreadable by the running old-
key API, so rotate in a maintenance window); there is no multi-key read
mode; the version byte in the box format remains the hook for that future
improvement.

## Notion database property mapping (M9 — implemented)

Destinations now distinguish pages from databases end to end. For a
DATABASE default destination the user can map Nova fields — title
(required), summary, source URL, tags, priority, captured-at, Nova moment
reference — onto their database's property NAMES (Settings → database
property mapping; available properties listed from the live schema via
`GET /v1/integrations/notion/destinations/:id/properties`).

The mapping is validated BEFORE saving (`PUT
/v1/integrations/notion/destination` fetches the database schema and
rejects unknown properties and incompatible types with per-field issues),
stored per user in their own connection row, and shown on the approval
card. At execution the worker re-validates against the live schema:
properties renamed/retyped since save are dropped (the approved page still
lands, title always survives) rather than failing the action. Type
compatibility: title→title, summary→rich_text, source URL→url|rich_text,
tags→multi_select, priority→select|rich_text, captured-at→date, moment
ref→rich_text|url. One shared validator + property builder
(`@nova/context-engine` notion-mapping) serves API and worker — the
mapping previewed is the mapping executed. Screenshots remain excluded
from Notion (the preview card now says so explicitly, with the moment's
media count).

## Search (M9 quality pass v2)

- **Prefix fallback**: when whole-word FTS finds nothing, the query reruns
  with prefix-matching lexemes (`kubernet deplo` → `kubernet:* & deplo:*`)
  over the same tsvector (which includes safe OCR text). Tokens are
  stripped to letters/digits so user input cannot inject tsquery syntax.
  Fallback hits are flagged (`legs.prefix_fallback`, per-item diagnostics).
- **Ranking diagnostics**: `debug: true` on `/v1/memory/search` adds raw
  per-item leg scores (`fts_rank`, `vector_similarity`, `prefix_fallback`)
  — the user's own data only.
- **Golden fixtures**: a pinned suite asserts expected top hits, media-OCR
  retrieval (incl. partial), filters, and that masked sensitive values are
  unreachable even via prefix search.
- **Documented limitations**: prefix matching is not typo tolerance
  (transpositions/misspellings miss); fusion weights (0.6 FTS/0.4 vector)
  remain untuned; the vector leg needs `OPENAI_API_KEY` and existing
  embeddings; English stemming only; `ocr_text` is capped at 50k chars per
  moment.
