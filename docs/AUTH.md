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

## Visual Redaction Integrity (M19A — implemented)

M7 produced a report on every image. It did not check whether OCR had
anything readable to work with. That gap (audit finding **D-10**) is closed
here.

**The defect.** The extension downscaled captures to 800px wide before
upload. At that size a 14px line of body text becomes roughly 5.8px and
Tesseract reads nothing. Zero words ⇒ zero sensitive boxes ⇒ zero masks ⇒
the image was stored, unmasked, as `redaction_state: 'applied'`. The
secrets stayed legible to a human; the record said they had been removed.
Reproduced against real Tesseract on this repo: of six sampled
resolution/font combinations, five went from 1–5 detected boxes at native
resolution to **zero boxes and `applied`** after the downscale.

**The invariant.** `applied` now means: OCR ran at a resolution where its
output is meaningful, and every sensitive box it produced was masked. An
image that cannot meet that bar is never reported as `applied`, in any mode.

**Analysis-resolution floor.** `MIN_ANALYSIS_WIDTH` × `MIN_ANALYSIS_HEIGHT`
(1280×600), enforced server-side in `@nova/context-engine/visual-redaction`.
Width is the load-bearing check — the defect is a width-driven downscale, and
height follows by aspect ratio. The height minimum only rejects degenerate
slivers; it is deliberately below 720 so that ordinary full-fidelity viewports
(a 1366×768 laptop's browser viewport is roughly 1366×625) are not silently
stripped of every screenshot for no safety gain.
Below it, `redactImageDataUrl` returns `coverage: 'insufficient_resolution'`
**without calling OCR at all** — a result we would not trust is not worth
producing, and not producing it removes any temptation to count it. The
floor lives on the server precisely so no client, old or hostile, can
bypass it by claiming to have redacted something.

**Pipeline order (M19A refinement).** decode → coverage check → OCR →
classify → mask into the decoded bitmap → re-encode. Decoding moved to the
front: dimensions must be known before OCR is worth running.

**States.** `image_redaction.state` gains one value:

| State | Meaning | Safe to store/read/export? |
|---|---|---|
| `applied` | OCR ran above the floor; all detected sensitive boxes masked | Yes |
| `none` | No image in the payload | Yes |
| `coverage_insufficient` | **M19A** — the artifact was below the analysis floor, so no redaction guarantee exists | **No** |
| `failed` | OCR itself errored | No |
| `blocked_strict` | Unsafe outcome in strict mode; image dropped | No |
| `skipped` / `storage_disabled` / `media_unavailable` | Redaction off / kill switch / no media pipeline | No |

`isSafeMediaRedactionState` is unchanged: `applied` and `none` only.
`coverage_insufficient` therefore fails closed everywhere it matters — no
`moment_media` row is written, no blob reaches object storage, direct media
reads 404, exports withhold the pixels with
`excluded_reason: 'redaction_not_applied'`, and the adapter gate refuses it.

**Strict vs non-strict.** `strict_image_redaction` defaults to **true** in
the request schema and is forced on in production, so the default outcome
for an uncertifiable capture is `blocked_strict` — the image is dropped
before the media pipeline. `coverage_insufficient` is only reachable when a
client explicitly opts out of strict mode; the image is still never stored,
but the moment records honestly *why* the guarantee is missing. `failed`
outranks `coverage_insufficient` when both occurred (the harder failure).

**Live Q&A.** A frame below the floor is DROPPED, exactly like an OCR
failure. Sending pixels we could not scan to a cloud model is the same
privacy defect as storing them.

**Client capture resolution.** Because the floor is a hard gate, the
extension had to stop destroying its own captures: `CAPTURE_MAX_WIDTH`
1920 at q0.8 (was 800 at q0.75) and `LIVE_FRAME_MAX_WIDTH` 1280 at q0.6
(was 640). A 2560×1440 screen uploads at ~79KB base64 — comfortably inside
the schema's 1.5MB `screenshot_data_url` cap.

**Backward compatibility.** The floor gates *new* analysis. Media already
stored as `applied` keeps its state and stays readable and exportable, even
when its recorded dimensions are below today's floor; M19A changes what
Nova accepts, not what it already promised about data the user has.

**Limitations (still honest).** The floor makes the `applied` claim
truthful; it does not make OCR complete. Recall above the floor is good but
not 100% — stylized fonts, rotated text, and non-text sensitive pixels
remain undetected, so blur/text-only modes are still the right tool for
high-risk screens. The check also reads pixel *dimensions*, not legibility:
an artifact downscaled and then upscaled back over the floor would pass it.
And a genuinely small source (a narrow window, a <1280px-wide display) is
refused rather than guessed at — the moment is still captured, only its
pixels are dropped. What M19A guarantees is that when Nova *says* redaction
was applied, a scan at a credible resolution actually happened.

**Proof.** Real-Tesseract matrix (gated, ~41s):

```
NOVA_OCR_E2E=1 pnpm --filter @nova/api vitest run \
  test/integration/m19a-visual-redaction-ocr.test.ts
```

It sweeps 1366×768 / 1920×1080 / 2560×1440 and font sizes 12–48px, and
asserts that no downscaled artifact reaches `applied` at any combination
while native-resolution captures still detect and mask. Deterministic
suites (`visual-redaction-coverage.test.ts`, `image-redaction-coverage.test.ts`,
`m19a-redaction-persistence.test.ts`) cover the gate, the state resolution,
and end-to-end persistence without needing OCR.

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
M19A adds one step at the front of the visual stage — decode and check the
analysis-resolution floor before OCR — and one more way to fail closed:
an image below the floor is `coverage_insufficient`, which
`isSafeMediaRedactionState` rejects, so no row and no blob are ever written
for it.

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

## Account data lifecycle (M10 — implemented)

The user is root authority over their data. Two endpoints complete the
loop that per-item export/delete started:

**Full account export.** `GET /v1/export/account?media=refs|full`
(authenticated; web Settings → Account data lifecycle). One JSON document:
profile, projects, every moment (payload, redaction reports, ocr_text,
enrichment), tasks, actions (incl. external ids), integration connection
METADATA (the `token_ciphertext` column is never even selected — tokens
cannot appear in an export in any form), active session metadata, the full
audit log, product events, and all enrichment versions. `media=refs`
(default) links media by authenticated URL; `media=full` inlines blobs as
data URLs ONLY for media whose visual redaction provably ran
(`redaction_state` 'applied', or 'none' — the image never carried maskable
text); anything else exports as metadata with
`excluded_reason: "redaction_not_applied"` — unredacted pixels never leave.
The export itself is audited (`export`, scope `account`).

**Full account deletion.** `POST /v1/auth/account/delete` requires three
independent proofs of intent: a WEB session (extension tokens get 403),
the account password, and the literal confirmation string `"DELETE"`. The
web UI adds a fourth (native confirm dialog) and recommends exporting
first. Because it verifies the password, the endpoint is rate-limited like
login — deletion cannot double as a brute-force oracle. Flow: the account
is LOCKED first (`users.deleted_at` set + every session revoked, so a
crash mid-deletion leaves an unusable account, never a half-deleted usable
one); media blobs are then deleted from object storage (failures
tombstone into `media_delete_queue`, which survives the account so
`media:cleanup` can finish the job — the deletion itself never fails on a
storage outage; if the media pipeline is down entirely, every key is
queued instead of silently leaking objects); integration token ciphertext
is overwritten before the
rows go; then one transaction writes the tombstone and deletes the user
row, cascading every table. The dead sessions make all future API use an
ordinary 401.

**Retention contract — what survives a deletion, explicitly:**
| Data | Fate |
|---|---|
| Captured content (payloads, text, OCR, media blobs, thumbnails) | **Deleted.** Never retained. |
| Projects, tasks, actions, enrichment (+versions), embeddings, entities | Deleted (cascade). |
| Sessions, pairing codes, OAuth states | Deleted → all tokens dead. |
| Integration tokens | Ciphertext overwritten, then row deleted. |
| Audit log, product events | Deleted (cascade) — they reference a person who asked to be gone. |
| `account_tombstones` row | **Retained**: deleted user id, sha256(email), row/object counts, timestamp. The security/abuse record that an account existed and was deleted. No content, no plaintext identity. |
| `media_delete_queue` rows | **Retained until drained**: keys of encrypted blobs whose storage delete failed; `media:cleanup` removes the objects. Ciphertext only, unreadable without the (user-independent) service key. |

**External deletion semantics (documented policy).** Nova never silently
deletes content it created in external systems. Deleting the account (or
disconnecting Notion) revokes the connection, destroys the token, and
deletes Nova's local records of external objects (action results with page
ids) — the pages themselves remain in the user's Notion workspace, where
the user already has native control over them. Optional external cleanup
(archiving Nova-created pages on request) is deliberately NOT implemented;
if it ever is, it must be explicit, previewed, and audited per object.

## Notion media consent (M10 — implemented)

Screenshots now CAN reach Notion — but only through an explicit, per-
action, per-image consent chain with the M8/M9 pipeline as the sole
source:

1. **Preview** (`GET /v1/actions/:id/preview`) lists every media object on
   the linked moment with its redaction state and an `eligible` flag —
   only `redaction_state = 'applied'` (visually redacted) media is ever
   eligible. The approval card renders one checkbox per eligible image,
   all UNCHECKED; ineligible media is shown greyed with the reason.
2. **Approval** (`POST /v1/actions/:id/approve` with `media_ids`) accepts
   only the caller's own media, attached to THIS action's moment, with
   redaction applied — anything else rejects with `invalid_media` before
   any state change. The consented ids land in the action payload
   (preview == execution) and the approval audit records the count.
   Approving without ticking anything stores an explicit empty list.
3. **Execution** (worker) re-verifies each approved media NOW — deleted
   rows, missing blobs, or a redaction state that regressed since approval
   fail the action terminally (`approved_media_*`) rather than publishing
   something the user didn't see. Reads go through the guarded adapter
   path (same rule as the API's `getForAdapter`), each access is audited
   (`media.adapter_access`: media id + provider + action id, never
   pixels), and bytes are uploaded via **Notion's File Upload API**
   (create upload → multipart send → attach as `file_upload` image
   blocks). Raw base64 never appears in any page body. Media-free actions
   never touch the store.

Notion API note: file uploads require the workspace/integration to
support the File Upload API; upload legs share the transient(429/5xx =
retry)/terminal(4xx = fail) semantics of every other Notion call.

## Enrichment versioning (M10 — implemented)

Enrichment runs no longer overwrite history. Every run appends an
immutable `enrichment_versions` row (version n+1, summary, enrichment
JSON, provider, model when one ran, created_at); the moment's
`summary`/`enrichment` columns remain the CURRENT pointer.
`GET /v1/context/moments/:id/enrichment/versions` lists the history;
`POST .../enrichment/select {version}` moves the pointer to any recorded
version (audited, nothing lost). Version content derives from already-
redacted moment data — text redaction ran before anything reached the
enrichment pipeline.

## Private alpha operations (M11 — implemented)

**Health & readiness.** `GET /healthz` (liveness) and `GET /readyz`
(Postgres + pending-migrations + Redis + a media-store write/read/delete
probe; booleans only, public — this is the deploy gate). The worker writes
a Redis heartbeat every 30s (90s TTL); `GET /v1/ops/status` (authed, like
every /v1 route) adds worker freshness, queue depths, failed-action and
pending-delete counts, global storage totals, the last maintenance run,
and the build sha — counts and booleans only, rendered on the web
`/status` page. Full checklist, failure-mode table, backup/restore
procedure, and smoke instructions: `infra/DEPLOY.md`.

**Maintenance.** `ops:maintenance` (dry-run default, `--apply` to act):
media orphan cleanup + delete-queue drain, dead-session sweep (7-day
retention window), expired pairing codes / OAuth states / password-reset
tokens, failed-action VISIBILITY (never deleted), and product-event
pruning only with an explicit `--prune-events-days`. Sections fail in
isolation; every run is recorded (ops_maintenance_runs) and shown on
/status.

**Observability.** API responses carry `x-request-id` (incoming header
honored, otherwise minted); worker logs are structured (pino) with
job/action/moment ids and error classes; security events (login failed /
rate limited, password reset requested/completed) are logged by NAME only.
The log contract is tested: captured content, passwords, session tokens,
and encryption keys never appear in log output.

**Password reset (self-service, operator-delivered).** `POST
/v1/auth/password-reset/request` always answers 202 identically (no
account enumeration) and mints a hashed, single-use, 30-minute token when
the account exists; alpha has no email sender, so the OPERATOR retrieves
and delivers the link out-of-band: `pnpm --filter @nova/api
auth:reset-token -- <email>` (prints the URL once; refuses in production
without NOVA_OPERATOR_RESET=yes). `POST /v1/auth/password-reset/confirm`
claims the token atomically, sets the new password, and revokes EVERY
session. Both legs are rate-limited; audits carry no token material.

**Multi-key media read (zero-downtime rotation).** The M9 limitation is
gone: `NOVA_ENCRYPTION_KEYS_PREVIOUS` (comma-separated) lets the API and
worker READ media — and integration tokens — encrypted under previous
keys while all writes use the current `NOVA_ENCRYPTION_KEY`. Rotation is
now: deploy new-key + previous-key config (no read outage), run
`media:rotate-key -- --apply` gradually, `media:verify` with only the new
key, drop the previous key. GCM trial decryption means a wrong key can
never emit garbage plaintext; blobs no configured key opens are refused
(and surfaced by `media:verify`, the backup/restore verification command).

**Shared adapter media gate.** The policy for pixels leaving Nova toward
ANY adapter lives in exactly one place now:
`@nova/context-engine/media-gate` (`readMediaForAdapter`). The API's
`MediaService.getForAdapter` and the worker's execution read are both thin
wrappers over it — user-scoped, redaction-state-gated (worker keeps the
stricter applied-only stance), deleted/tombstoned media blocked, audited
by every caller. The gate cannot drift between services because there is
only one gate.

**Notion media upload hardening.** Upload ids are persisted onto the
action row per media BEFORE the next step, so queue retries re-use them —
no duplicate media objects in the workspace (test-pinned). Uploads run
BEFORE page creation by design, so "upload failed after the page exists"
cannot occur; the page is created once, last, with everything attached,
and the existing page-id short-circuit still dedups page creation. A gated
live smoke (`notion-live-smoke.test.ts` + checklist in DEPLOY.md) covers
the real provider.

## Search (M9 quality pass v2, tuned in M11)

M11 tuning notes: field weights are the ranking contract — intent text
(A) > title (B) > body/OCR text (C) — now pinned by a golden test with
the same term planted in all three fields. Fusion stays 0.6 FTS / 0.4
vector (unchanged after review: with FTS-only rankings pinned by goldens
and the vector leg optional, retuning the blend without embedding
coverage would overfit). Ranking diagnostics remain opt-in via
`debug: true` and expose raw per-leg scores for the caller's own data
only.

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
