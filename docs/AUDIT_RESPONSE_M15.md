# M15 — Alpha Blocker Remediation (Hermes audit response)

External adversarial audit by **Hermes** reviewed Nova Context at baseline
commit **`49b6525`** and returned **NO-GO** for private alpha until the P1
findings are fixed and real deployment checks are verified.

Every finding below was treated as valid. Each was reproduced against the
baseline code, fixed, and covered by a regression test. Nothing here argues
the auditor was wrong.

Status after M15: all original P1/P2/P3 findings remediated with tests.
A Hermes **delta audit then reviewed PR #11 at head `8e820be` and returned
FAIL**, raising six findings (M15-D01…D06), remediated in **M15B**. A
**second** delta audit reviewed M15B at head **`68e4753`** and returned
**FAIL** with one residual **P1 blocker M15B-R01** (case-sensitive
inline-media detector) + a **P2 M15B-R02**; both were remediated in **M15C**.
A **third** delta audit reviewed M15C at head **`56c44b9`** and returned
**CONDITIONAL PASS — PR #11 may merge with explicit acceptance of one P2
residual** (see "Hermes conditional pass" below).

**PR #11 is cleared to merge under the conditional pass. The M14 hard gate
still stands: real alpha remains BLOCKED — no real user data until controlled
deploy/smoke/backup/restore verification is done for real AND the operator
explicitly approves. Merging M15 does NOT approve the alpha.**

> Reading order: **Hermes conditional pass** (immediately below) is the
> current state, then **M15C**, **M15B**, then the original **M15** (history).

---

## Hermes conditional pass (3rd delta, head `56c44b9`)

**Verdict: CONDITIONAL PASS.** Hermes confirmed at `56c44b9`:
- **M15B-R01 (P1) closed** — the mixed-case legacy inline-media bypass is
  fixed; no remaining mixed-case bypass in legacy/API/export/backfill; the
  backfill detects mixed case via `ILIKE` + the canonical detector; legacy
  `/v1/export` and account export are free of mixed-case `data:image` leaks.
- **D02/D03/D04/D05 remain closed.** No new P0, no new P1.
- CI for `56c44b9` completed successfully.

**Accepted residual — M15C-R02 / P2 (`backup:seal` symlink aliasing).** The
direct `backup:seal` CLI compares `--work` vs `--out` with `path.resolve`
(lexical), which a **symlink** between the two could still defeat, so a
determined direct caller could seal in place. This does **not** block merge.
- **Operator rule (mitigation):** run operator backups ONLY via
  `scripts/backup.sh` — never invoke `backup:seal` directly. `backup.sh`
  always passes a private `mktemp` `--work` and a separate `--out`, so the
  aliasing path is never exercised in the supported flow.
- **Future hardening (not required for merge):** make `backup:seal` compare
  *physical* directories via `realpath()` (resolving symlinks) or reject
  symlinked `--work`/`--out`.

**Alpha still blocked.** Real alpha is not approved by this pass — it remains
gated on real deploy/smoke/backup/restore verification and explicit operator
approval.

Other accepted residuals (P3, non-blocking): `applyCaptureMode` array
handling; additional restore-CLI test coverage.

---

# M15C — Legacy Inline Media Normalization Fix (Hermes 2nd delta response)

The **second** Hermes delta audit reviewed M15B at head **`68e4753`** and
returned **verdict: FAIL — do not merge PR #11 yet.** It confirmed
M15-D02/D03/D04/D05 closed and D06 partial-but-non-blocking, with no new P0
and no new unrelated P1 — leaving one residual blocker, fixed here on the
same branch (`claude/m15-nova-context`). Alpha remains blocked until Hermes
re-audits.

## M15B-R01 (P1) — Legacy inline-media detection was case-sensitive

**Confirmed at `68e4753`.** Every inline-media detection point used a
case-sensitive `startsWith("data:image/")` (and the backfill candidate scan
used a case-sensitive SQL `LIKE '%data:image%'`). Because a data URI is
case-insensitive by spec, a mixed-case legacy payload —
`DATA:image/svg+xml,…`, `Data:Image/png;base64,…`, `data:IMAGE/…` — bypassed
the `sanitizeLegacyInlineMedia()` reader gate **and** the backfill, and could
leak through the API/export.

**Fixed — one canonical, case-insensitive detector, used everywhere.** A new
dependency-free module `packages/context-engine/src/data-url.ts` exports the
single source of truth:

- `IMAGE_DATA_URL_RE = /^\s*data:image\//i` and `isImageDataUrl(v)` — matches
  every case variant (and tolerates leading whitespace);
- `isDataUrl(v)` (`/^\s*data:/i`) for the "skip binary from text scanning" path.

Every detection point now routes through it (no lowercase `startsWith`
survives):

- `services/api/src/legacy-media.ts` — the outward reader gate on
  `rowToMoment`; the `screenshot_data_url` key is also matched
  case-insensitively (`Screenshot_Data_URL` is dropped too);
- `services/api/src/db/backfill-media.ts` — the candidate scan is now
  **`ILIKE '%data:image%'`** and the per-row walk uses `isImageDataUrl`, so
  mixed-case rows are quarantined identically to lowercase;
- `services/api/src/image-redaction.ts` — the ingest extraction/strip walk
  (`extractPayloadImages`, `stripImages`);
- `packages/context-engine/src/capture-mode.ts` — `text_only` enforcement;
- `packages/context-engine/src/redaction.ts` — the data-URI skip.

Detection catches `data:image/png;base64,…`, `DATA:image/…`,
`Data:Image/png;…`, `data:IMAGE/svg+xml,…`, and any mixed-case variant,
nested in objects or inside arrays.

**Tests (mixed-case fixtures throughout):**
- `packages/context-engine/src/data-url.test.ts` — the canonical detector
  matches every case variant and rejects non-image/non-data strings.
- `services/api/src/legacy-media.test.ts` — `DATA:image`, `Data:Image`,
  `data:IMAGE/svg+xml`, mixed-case nested/arrayed values, and a mixed-CASE
  `Screenshot_Data_URL` key are all stripped with the safe metadata
  (`legacy_media_detected/excluded`, `excluded_reason`).
- `services/api/test/integration/m15b-legacy-media.test.ts` — a second seeded
  row with `DATA:image` top-level, a nested `{ screenshot: "Data:Image…" }`,
  and an array element `data:IMAGE/svg+xml,<svg>` never leaks (asserted with a
  case-insensitive `/data:image/i` regex **and** `<svg`) through single GET,
  list, legacy `/v1/export`, account export, or search — while sibling text
  survives.
- `services/api/test/integration/backfill-media.test.ts` — a mixed-case
  (`DATA:IMAGE`) nested legacy row is quarantined (`quarantined_legacy`,
  audited, nothing in object storage), proving the `ILIKE` scan catches it.

**Expected behavior held:** no response/export contains the original data URI
in any case; safe metadata remains; backfill quarantines/records mixed-case
media the same as lowercase.

## M15B-R02 (P2) — `backup:seal` accepted an unsafe in-place mode

**Confirmed at `68e4753`.** `backup:seal` accepted a `--dir` alias (and
defaulted `out = work`), allowing plaintext and sealed artifacts to share one
directory — defeating the D02 no-plaintext guarantee for anyone calling the
tool directly. The wrapper `backup.sh` already passed separate dirs, so this
was not a live leak, but the unsafe path existed.

**Fixed** (`services/api/src/backup/run-seal.ts`). `--work` and `--out` are
both required and must be **distinct** (compared via `path.resolve`); the
`--dir` alias is rejected outright. `scripts/backup.sh` is unchanged and
still passes a private `--work` and a separate `--out`.

**Tests** (`services/api/test/integration/m15c-seal-guard.test.ts`, real
CLI): `--dir=…` is rejected; `--work===--out` is rejected.

## M15C P3 / residuals

- **D06 (extension default-strict + restore CLI coverage)** — the M15B
  coverage stands (extension default-strict unit test; backup/restore CLI
  tests for missing key, seal-failure cleanup, DSN redaction, unsafe-target
  guard). Hermes rated D06 partial/non-blocking; no further restore-CLI cases
  were added in M15C to avoid overbuilding — accepted as a documented
  residual.
- No schema change: new-capture validation of the `screenshot_data_url` field
  (`packages/schema`) stays case-sensitive by design — a mixed-case value in
  that field is *rejected* at ingest (fail-closed), not stored; the
  case-insensitive gates above cover every stored/legacy/other-field path.

## M15C verification

- `pnpm build` + `pnpm -r typecheck` — clean (all 9 projects).
- `@nova/context-engine` 68 (incl. `data-url`), API unit 49 (incl. mixed-case
  `legacy-media`).
- Integration (Postgres + Redis): `m15b-legacy-media` (6, mixed-case),
  `backfill-media` (1, mixed-case quarantine), `m15c-seal-guard` (2),
  `m15b-backup-cli` (5) green; full API + worker suites re-run green.

## M15C alpha status

M15B-R01 (the residual P1) and R02 (P2 lexical `--work`/`--out` check) are
fixed and tested and CI is green. Hermes' 3rd delta audit (head `56c44b9`)
returned a **CONDITIONAL PASS**: PR #11 may merge with explicit acceptance of
the remaining P2 (`backup:seal` symlink aliasing — mitigated by the
operator rule "use `scripts/backup.sh`, never `backup:seal` directly"; see
"Hermes conditional pass" above). **Merging M15 does NOT approve the real
alpha** — that stays blocked on real deploy/smoke/backup/restore verification
and explicit operator approval.

---

# M15B — Delta Audit Remediation (Hermes delta response)

The Hermes **delta audit** reviewed PR #11 / M15 at head **`8e820be`** and
returned **verdict: FAIL — do not merge PR #11. Alpha remains blocked.** Six
findings were raised. Every one was treated as valid, reproduced against
`8e820be`, fixed on the same branch (`claude/m15-nova-context`), and covered
by a regression test. **No test asserts that unsafe data remains externally
visible.**

Alpha remains blocked until Hermes re-audits these changes.

## M15-D01 (P1) — Legacy inline media evades the new media/export gates

**Confirmed at `8e820be`.** The M15 read/export gates key off the
per-artifact `image_redaction.state`, but **pre-M8 rows** stored the
screenshot *inline in `context_moments.payload`* (`screenshot_data_url`,
`data:image/...`) with no separate media row and no state to gate on. Those
payloads were serialized verbatim by `rowToMoment`, so a legacy inline image
could still be returned by every payload-returning path (single, list,
timeline, project, search, legacy `/v1/export`, account export) and the
backfill left the unsafe payload in place.

**Fixed — outward sanitizer (fail-closed) + backfill quarantine:**

1. **Outward read sanitizer** (`services/api/src/legacy-media.ts`,
   `sanitizeLegacyInlineMedia`). A single fail-closed function recursively
   strips any `screenshot_data_url` key and any `data:image/...` string from
   a payload and, when it removes anything, stamps
   `{legacy_media_detected:true, legacy_media_excluded:true,
   excluded_reason:"legacy_inline_media_not_verified"}`. Clean payloads pass
   through untouched. It is wired into **`rowToMoment`** — the single
   chokepoint every payload-returning path funnels through — so single, list,
   timeline, project, search, legacy `/v1/export`, and account export are all
   sanitized at the source, whatever is on disk.
2. **Backfill quarantine** (`services/api/src/db/backfill-media.ts`). Rows
   whose inline media cannot be proven safe (no OCR text, or redaction
   failed) are now **quarantined**: the inline payload is stripped in the
   database, `image_redaction.state` is set to `quarantined_legacy`, and a
   `media.backfill_quarantine` audit row is written. Defense in depth — even
   a path that somehow bypassed the reader now finds nothing unsafe in the row.

**Tests:**
- `src/legacy-media.test.ts` (unit): strips `screenshot_data_url` + flags;
  handles nested/arrayed `data:image`; leaves clean payloads untouched;
  tolerates null/primitive.
- `test/integration/m15b-legacy-media.test.ts`: inserts a pre-M8 row with an
  inline `screenshot_data_url` and asserts single GET, list, legacy
  `/v1/export`, account export, and search **never** return `data:image`.
- `test/integration/backfill-media.test.ts`: the unprovable legacy row is
  quarantined (`screenshot_data_url` gone, `legacy_media_excluded:true`,
  `state==='quarantined_legacy'`, quarantine audit present) and the backfill
  is idempotent.

## M15-D02 (P1) — Backup could leave plaintext if sealing failed

**Confirmed at `8e820be`.** `backup.sh` wrote the plaintext pg_dump/tar into
the final backup dir and sealed *in place*; if `backup:seal` threw (bad key,
crash, interrupt) the plaintext dump/tarball was left behind, and there was
no cleanup trap.

**Fixed.** `scripts/backup.sh` now writes all plaintext ONLY into a private
`0700` `mktemp -d` **workspace**, seals from there into a staging dir, and
**`mv`s only the `.enc` + manifest into the final dir after sealing
succeeds**. A `trap cleanup EXIT INT TERM` wipes the workspace on every exit
path, and `umask 077` is retained. If sealing fails the script exits before
the publish step, so the final dir never contains plaintext — and the
workspace is wiped regardless. `backup:seal` (`src/backup/run-seal.ts`) takes
`--work`/`--out`, encrypts from work into out, and unlinks each plaintext
after sealing.

**Tests** (`test/integration/m15b-backup-cli.test.ts`, real scripts via
`execFileSync`):
- success → final dir holds only `*.enc` + `manifest-*` (no `*.dump`/`*.tar.gz`);
- **sealing failure** (structurally invalid key) → final dir has **no
  plaintext and no `.enc`** — nothing published, workspace trapped;
- missing `NOVA_BACKUP_KEY` → fails and writes nothing.

## M15-D03 (P1) — `restore.sh` echoed the DSN and trusted `nova_alpha`

**Confirmed at `8e820be`.** `restore.sh` printed the full `DATABASE_URL`
(embedded user/password) and treated any database named `nova_alpha` as a
safe non-production target via a string allowlist — so a **remote** DSN whose
db was named `nova_alpha` would restore with no override.

**Fixed.** A pure, unit-tested classifier
(`src/backup/target.ts`) drives the shell:
- `redactDatabaseUrl` → `scheme://***@host:port/db`, never the credentials;
- `classifyRestoreTarget` treats a target as local **only** when the host is
  loopback (`localhost`/`127.0.0.1`/`::1`) **and** `NODE_ENV!==production`.
  The database *name* is irrelevant — a remote `nova_alpha` is not local.

`scripts/restore.sh` calls the `backup:restore-guard` CLI
(`src/backup/run-restore-guard.ts`), prints **only** the redacted target,
and — for any non-local target (exit 3) — refuses unless
`NOVA_RESTORE_ALLOW_PRODUCTION=yes`. The typed `RESTORE` confirmation now
references "the target shown above", never the raw DSN.

**Tests:**
- `src/backup/target.test.ts` (unit): redaction removes user/pass; remote
  `nova_alpha`, production loopback, and any remote host all require the
  override.
- `test/integration/m15b-backup-cli.test.ts`: a remote
  `postgres://admin:sup3rs3cret@db.remote.example.com/nova_alpha` is refused,
  the secret never appears in output, `***@db.remote.example.com` does, and
  the override is named; a local DSN never prints its password either.

## M15-D04 (P2) — Manifest was not fully authenticated

**Confirmed at `8e820be`.** The manifest recorded sha256 hashes but was
otherwise unauthenticated: an attacker who could rewrite the manifest could
alter sizes, timestamps, or the artifact/role set, or drop the postgres
artifact, and hash-only verification would not necessarily catch it.

**Fixed** (`src/backup/manifest.ts`). The manifest now carries an
**HMAC-SHA256 `mac`** over a canonical (sorted-key) JSON body keyed with
`NOVA_BACKUP_KEY`, plus **shape validation**: allowed roles
(`postgres`/`media`), a **required `postgres` artifact**, and per-artifact
**size + sha256**. `verifyBackup` checks the MAC first (constant-time), then
shape, then per-artifact size, hash, and decryptability. Tampering with any
covered field (size, timestamp, role set) breaks the MAC; a wrong key fails
both MAC and decrypt.

**Tests** (`src/backup/manifest.test.ts`): good backup passes MAC + shape +
size + hash + decrypt; the MAC catches a tampered size, a tampered
timestamp, and an added role; a manifest missing the postgres artifact is
rejected; a ciphertext tamper is caught by the hash even without the key; a
wrong key fails MAC and decrypt; the manifest carries no key material.

## M15-D05 (P3) — `/v1/ops/status` returned raw dependency error strings

**Confirmed at `8e820be`.** The authenticated `/v1/ops/status` route
surfaced raw dependency error messages (which can carry hostnames, ports,
paths, bucket names) directly in the response body.

**Fixed** (`src/routes-ops.ts`). `opsStatus` now maps a failing dependency to
a stable `{error:"unavailable"}` (or `{ok, detail}` for healthy checks with
no raw string) in the response, and routes the raw error text to the
**request-scoped structured log** via an injected logger
(`req.log.warn(..., "ops_status_dependency_errors")`) tagged with the request
id. Raw detail reaches operators through logs, never the API response.

**Tests** (`src/routes-ops.test.ts`): with a db/redis/store that throw
messages stuffed with `ECONNREFUSED`, hosts, ports, a bucket name, and a
filesystem path, the serialized status body contains **none** of them, while
the captured log **does** — proving the split.

## M15-D06 (P3) — Coverage gaps

**Fixed** by the tests added above plus:
- `apps/extension/utils/api.test.ts`: a fresh install defaults to
  `strictRedaction:true` (`DEFAULT_EXTENSION_SETTINGS`), and the extension now
  ships a `vitest` `test` script so this runs in CI. (Production also forces
  strict server-side regardless of the client flag — see the M15 P1 section.)
- Backup/restore CLI coverage (`test/integration/m15b-backup-cli.test.ts`):
  missing backup key, sealing-failure cleanup, DSN redaction, restore
  confirmation, and the unsafe-target guard — all exercised against the real
  `scripts/backup.sh` / `scripts/restore.sh`.

## M15B verification run

- `pnpm --filter @nova/api build` + typecheck — clean.
- API unit — **46 passed** (incl. `legacy-media`, `target`, `manifest`
  MAC/shape/tamper, `routes-ops` sanitizer).
- `@nova/schema` 7, `@nova/context-engine` 65, `@nova/extension` 1 — green.
- Integration (Postgres + Redis): `m15b-legacy-media` (5), `backfill-media`
  (1), `m15b-backup-cli` (5) — green; full M0–M14 + alpha-blockers suites
  re-run green.

## M15B remaining risks / notes

- The outward D01 sanitizer is the guaranteed gate; backfill quarantine is
  the DB-cleanup complement. Both ship, but the reader is the invariant — no
  payload path bypasses `rowToMoment`.
- All the accepted risks from the original M15 write-up (per-instance
  rate-limit fallback, s3 backups rely on operator bucket controls, Redis not
  backed up) still stand.

## M15B alpha status

**Alpha remains blocked.** The six delta findings are fixed and tested and CI
is green, but per the user's instruction this is **not** a PASS: the branch
now awaits a **Hermes re-audit** of the M15B changes. PR #11 is **not**
merged, no live alpha runs, and no real user data is captured until Hermes
re-audits and the operator explicitly approves.

---

# M15 — original P1/P2/P3 findings (history)

## P1 — Visual media retained/exportable when OCR fails

**Confirmed at baseline.** Non-strict OCR failure stored the image with
`redaction_state=failed`; the direct media endpoint and legacy `/v1/export`
returned pixels without checking the redaction state; extension and schema
defaults were `strict_image_redaction:false`.

**Fixed — defence in depth (any one layer is sufficient; all four ship):**

1. **Storage guard** — `MediaService.storeMomentImages` persists a blob
   ONLY when the redaction state is safe (`applied`/`none`). `failed`,
   `skipped`, `blocked_strict`, unknown → nothing stored. It is now
   structurally impossible to write a readable blob with an unsafe state.
   (`media-service.ts`)
2. **Production strict override** — capture computes
   `effectiveStrict = client_flag || isProduction`. In production a
   failing OCR yields `blocked_strict` (image dropped) regardless of what
   the client sent — an old/malicious client cannot request unsafe
   retention. (`app.ts`)
3. **Safe defaults** — schema default flipped to
   `strict_image_redaction: true`; extension default `strictRedaction:true`.
   (`packages/schema/src/context-moment.ts`, `apps/extension/utils/api.ts`)
4. **Read/export gates** — one shared rule (`isSafeMediaRedactionState`,
   `SAFE_MEDIA_REDACTION_STATES = {applied, none}`) enforced by:
   the direct read `GET /v1/media/:id` (404 for unsafe), `exportForMoments`
   (unsafe → `data_url:null` + `excluded_reason`, so legacy `/v1/export`
   and account export are both safe at the source), and the adapter gate
   (`@nova/context-engine/media-gate`, already `applied`-only).

Safe states: `applied`, `none`. Unsafe (never stored/read/exported):
`failed`, `skipped`, `blocked_strict`, `storage_disabled`,
`media_unavailable`, unknown, null.

**Tests** (`test/integration/alpha-blockers.test.ts`, plus updates to
`visual-redaction`, `media`, `media-ops`, `notion-media`):
- default capture (no flag) + OCR failure → `blocked_strict`, 0 media rows;
- production overrides an explicit `strict_image_redaction:false` → dropped;
- explicit non-strict still stores nothing (storage guard);
- direct `/v1/media/:id` → 404 for an unsafe row (blob present + decryptable,
  so only the state gate blocks it);
- legacy `/v1/export` → `data_url:null` + `excluded_reason`, no `data:image`;
- account export `?media=full` → excluded with reason;
- shared adapter gate → `redaction_not_applied` for unsafe media.

## P2 (finding two) — Backup confidentiality and restore guardrails

**Confirmed at baseline.** `backup.sh` produced a plaintext pg_dump + media
tar with no enforced permissions, no encryption, no integrity manifest;
`restore.sh` restored destructively with no production guardrail.

**Fixed.**

`scripts/backup.sh` — `umask 077`; backup dir forced to `700` and refuses a
looser directory; artifacts sealed with **AES-256-GCM** using
**`NOVA_BACKUP_KEY`** (a SEPARATE key from `NOVA_ENCRYPTION_KEY`, never
written into the backup); plaintext deleted after sealing (**no plaintext
artifact survives**); `manifest-<stamp>.json` records each sealed
artifact's sha256 + size + timestamp (no secrets); **fails closed** if the
backup key is missing. `backup:verify` recomputes the manifest hashes
(integrity without the key) and, with the key, confirms each artifact
decrypts.

`scripts/restore.sh` — explicit typed `RESTORE` confirmation; target-env
check that refuses a production-looking target without
`NOVA_RESTORE_ALLOW_PRODUCTION=yes`; `backup:verify` (manifest + decrypt)
BEFORE touching the database; unseal into a `700` temp dir; post-restore
`db:migrate` no-op + `media:verify` + smoke reminder; clear wrong-key
failure.

**Rehearsed (real run, this milestone):**
```
backup.sh → dir 700, files 600, only *.enc + manifest (no *.dump/*.tar.gz)
backup:verify (correct key) → hash:ok decrypt:ok → BACKUP OK
backup:verify (wrong key)   → hash:ok decrypt:fail → BACKUP VERIFY FAILED
tamper 1 byte               → hash:mismatch → BACKUP VERIFY FAILED
backup.sh (production, no NOVA_BACKUP_KEY) → refuses, exit 1
```

**Tests** (`src/backup/crypto.test.ts`, `src/backup/manifest.test.ts`):
sealed artifact leaks no plaintext; roundtrips exactly; wrong key/tamper
fail loudly; manifest verify catches tampering (no key) and wrong key (with
key); manifest carries no key material.

Policy (retention, location, deletion, key handling, restore drill) is
documented in `docs/RUNBOOKS.md` §Backup policy and `infra/DEPLOY.md`.

## P2 — Rate limiter fail-open on Redis failure

**Confirmed at baseline.** `RedisRateLimiter.allow` returned `true` on any
Redis error — a Redis blip meant unlimited login/signup/pairing/reset/delete
attempts.

**Fixed (preferred option).** On a Redis error the limiter now **fails
closed** via a per-instance in-memory fixed-window fallback (the attempt is
counted, not waved through), emits a structured `rate_limit_redis_unavailable`
security warning (event name + error class only), and marks itself
`degraded`. `status()` surfaces `{backend, degraded, last_error_at}`, shown
on `/v1/ops/status` (with a warning when degraded) and reflected by
`ops:preflight`. (`auth/rate-limit.ts`, `routes-ops.ts`, `ops/preflight.ts`)

Residual: the fallback is per-instance, so a multi-instance deploy loses the
shared window during a Redis outage. Preflight warns to keep gateway/WAF
rate limiting in front for the alpha; single-instance alpha is unaffected.

**Tests** (`src/auth/rate-limit.test.ts`): a dead Redis endpoint still
bounds attempts (`[true,true,true,false,false]` at max=3) and reports
`degraded:true`; the pure in-memory backend is never `degraded`.

## P3 — `/readyz` leaked internal dependency error messages

**Confirmed at baseline.** Public `/readyz` returned
`err.message.slice(0,200)` for failing components — potentially exposing
DB/Redis/object-store hostnames, paths, and ports to unauthenticated
callers.

**Fixed.** `/readyz` now returns ONLY the overall boolean plus a
per-component `{ok:boolean}`. Internal detail (error class, "N pending")
goes to the structured log with the request id via
`req.log.warn(..., "readiness_not_ready")` — never into the response body.
The authenticated `/v1/ops/status` keeps full internal detail.
(`routes-ops.ts`, `toPublicReadiness`)

**Tests** (`src/routes-ops.test.ts` unit + `test/integration/ops.test.ts`):
the public shape drops `error`/`detail`, and the serialized body contains no
hostnames, paths, ports, or error strings even when components are down.

---

## Verification run (this milestone)

- `pnpm build` + `pnpm typecheck` — clean.
- `pnpm test` — unit, all packages green (API 31, incl. backup crypto,
  manifest, rate-limit fallback, readyz strip, ocr).
- `pnpm test:integration` (Postgres + Redis) — **198 API (+1 gated) + 30
  worker** green, including the M0–M14 regression flows and the new
  `alpha-blockers` suite.
- Backup/restore + media-safety rehearsals as quoted above.

## Remaining accepted risks

- Rate-limit fallback is per-instance (documented; preflight warns;
  single-instance alpha unaffected; multi-instance should front a WAF).
- s3 media backups rely on the operator's bucket versioning/SSE (the
  fs-tar seal path is what M15 hardened); documented in the runbook.
- Redis/queue state is still not backed up (retryable work only — by
  design, documented since M11).

## Alpha status

**Still gated.** The P1 blockers are fixed and tested; the deployment
checks (preflight, sealed backup, verify, smoke) pass in rehearsal. Per the
M14 hard gate, the alpha does not start — and no real user data is
captured — until the operator explicitly approves. A Hermes **delta audit**
against this branch is recommended before that approval.
