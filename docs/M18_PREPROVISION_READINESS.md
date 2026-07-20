# M18A — Pre-Provision Deployment & Recovery Closure

Status: **executable cloud recovery closed and proven end-to-end (M18A / M18A.1
/ M18A.2 / M18A.3), with the three Hermes P1 findings against head `83a6185`
provisionally closed (M18A.4); awaiting a focused Hermes re-audit + operator
review before any provisioning.** No external resource has been created; no
production secret exists; nothing is deployed; no cost has been incurred; the
Render Blueprint is committed but NOT synced. Provisioning remains gated on the
operator's explicit `APPROVE M18 PROVISIONING` phrase.

## 0.4. M18A.4 — Hermes P1 closure (this milestone, PROVISIONAL)

Hermes ran an independent read-only audit of head `83a6185`: verdict **FAIL**,
**no P0**, **three confirmed P1 blockers**. M18A.4 closes those findings; this is
**not** a Hermes PASS, and merge/provisioning remain blocked pending exact-head
CI and a focused Hermes re-audit.

1. **NCA-17-001 — remote-recovery failures must never exit 0.**
   `validate:recovery-remote` had a `return` inside its orchestration `try` that
   bypassed the terminal exit after a non-zero fetch, so a missing marker,
   unreachable bucket, bad credentials, network failure, verification failure, or
   a thrown exception could print a failure yet exit 0. It now has ONE terminal
   path: an explicit result that starts non-zero, cleanup ALWAYS in `finally`, a
   cleanup failure upgrading to non-zero, and `process.exitCode` set once (via the
   pure `computeExit`) AFTER cleanup. Exit 0 requires gate PASS **and** a clean
   workspace removal. Proven by an exhaustive `computeExit` matrix + real-CLI
   spawns (usage, fetch-throws, forced-cleanup-failure → all non-zero, no `PASS`,
   no secret) + a real success→0 run in the Postgres/MinIO E2E.
2. **NCA-17-002 — `ops:smoke` cleanup failure-safe + provable.** The smoke's own
   synthetic account now has an explicit lifecycle recorded before signup, a
   `try/finally` that ALWAYS cleans up (lost signup response, login failure,
   network exception, mid-smoke throw, deletion failure), and PROVES the account
   dead — deleted via the real flow AND token no-auth (exact 401) AND credentials
   no-login (exact 401). HTTP 200 from delete is not proof; an unprovable cleanup
   FAILs (never "likely clean") → `ok:false` → non-zero exit. The E2E additionally
   asserts the smoke account is ABSENT after the drill.
3. **NCA-17-003 — DB identity + run-id hardening.** A shared `canonicalizeHost`
   collapses trailing-dot / case / default-port / credential variants into ONE
   identity across the target, expected, primary, and guard comparisons, so
   `db.internal.` can no longer split from `db.internal`. The run-id contract is
   strict + delimiter-bound: exactly 32 lowercase hex chars, and the scratch
   database name must END WITH `_<run-id>` — weak words (`nova`), uppercase, or an
   embedded-without-delimiter id are BLOCKED before `pg_restore`. Fingerprinting
   is defence in depth, NOT a replacement for provider IAM: recovery credentials
   must remain incapable of writing the primary database.

## 0.3. M18A.3 single executable recovery orchestration (this milestone)

Four correctness gaps between the recovery *pieces* and a single *executable*
drill are closed on this branch, and the full path is now exercised by a real
end-to-end test against Postgres + MinIO (`m18a3-recovery-e2e.test.ts`):

1. **One authorization decision reaches the destructive restore.** The
   automated drill and `scripts/restore.sh` now share ONE guard decision via
   `NOVA_RESTORE_MODE`. In `authorized-scratch` mode the script calls the EXACT
   `backup:scratch-guard` the gate validated (local loopback OR the full remote
   envelope) and the manual production override
   (`NOVA_RESTORE_ALLOW_PRODUCTION=yes`) is **inaccessible**; `NODE_ENV=production`
   is runtime-only and never by itself reclassifies a managed scratch DB as
   primary. The guard is **re-checked immediately before `pg_restore`**, so a
   DATABASE_URL swapped mid-run is caught by the same guard. `manual` (default)
   keeps the hands-on `backup:restore-guard` behavior.
2. **One authoritative DB/media order.** `restore.sh` does guard → verify →
   unseal → restore (DB, and fs media when present) only. Post-restore migration,
   S3 media restore, `media:verify`, and smoke are owned by the gate in the
   order DB restore → **S3 media restore** → `media:verify`; the script no longer
   runs `media:verify` before the media is restored, and migrations run once.
3. **A single off-box entrypoint.** `pnpm validate:recovery-remote` creates a
   NEW private 0700 workspace, `backup:fetch-s3` the committed set into it,
   invokes the gate `recovery` mode, and ALWAYS removes the workspace (reporting
   any cleanup failure and exiting non-zero on gate FAIL/BLOCKED or cleanup
   failure). The operator never hand-composes fetch + mkdir + gate + rm.
4. **Off-box completion semantics + robust unseal.** `scripts/backup.sh` never
   prints an unqualified "Backup complete" before an off-box publish+verify;
   a local-only seal on an ephemeral host is stated as "off-box durability not
   established", and `NOVA_BACKUP_REQUIRE_OFFBOX=yes` fails closed if publish is
   off. Decryption on the restore path uses the dedicated, GCM-authenticated,
   fail-closed `backup:unseal-file` command (replacing a fragile inline eval).

## 0.2. M18A.2 executable-recovery corrections (this milestone)

Three blockers that would have stopped a *real* Render + R2 recovery drill are
closed on this branch:

1. **Authorized remote scratch databases.** The recovery gate's scratch guard
   accepted only loopback Postgres, so a drill against a managed Render
   Postgres (internal remote host) always BLOCKED. `backup:scratch-guard` now
   admits an **explicitly-authorized remote scratch** class that passes ONLY
   when every condition holds: `NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH=yes`,
   `NOVA_RESTORE_TARGET_CLASS=scratch`, an exact expected host + database name +
   credential-free target fingerprint, a typed confirmation
   (`NOVA_RESTORE_SCRATCH_CONFIRM`), a database name containing `NOVA_RECOVERY_RUN_ID`,
   and a fingerprint proven ≠ `NOVA_PRIMARY_DATABASE_FINGERPRINT`. Any
   mismatch/absence/production-classification → BLOCKED before mutation; a
   malformed DSN → FAIL. No generic "allow remote restore" bypass exists, and
   the guard prints only a credential-free target + names-only reasons.
2. **No false-PASS synthetic cleanup.** A cleanup check now PASSes ONLY with
   affirmative evidence that no synthetic account/session remains. An ambiguous
   signup (timeout / network loss / 5xx / malformed / any non-definitive
   response) is `account_state_unknown`; cleanup attempts bounded recovery and
   FAILs (never "likely no orphan") if it cannot delete-and-prove. Post-delete
   proof requires exactly HTTP 401 (200/403/4xx/5xx/timeout all FAIL). Approach
   A requires exactly 401 after logout (403/5xx/unreachable FAIL).
3. **Sealed DB backup survives the ephemeral job.** `backup:publish-s3` /
   `backup:verify-s3` / `backup:fetch-s3` publish the COMPLETE sealed set
   (encrypted DB dump, encrypted media tar when present, the sealed manifest,
   and the media inventory) to a private `sealed-backups/<stamp>/` prefix,
   bound by an **HMAC-authenticated commit marker published LAST**. Fetch
   authenticates the marker, downloads into a private 0700 temp dir, verifies
   sizes/hashes, and runs `backup:verify` before restore — so a Render one-off
   job needs no persistent disk.

## 0. M18A.1 gate-integrity corrections (applied after the B1 review)

A focused review of the M18A work surfaced gate-integrity gaps; all are
closed on this branch: (1) the s3 media backup is now **two-phase, atomic,
and fail-closed** — a completeness scan reads/hashes every DB-referenced
object before any copy, every destination object is re-read/verified, and the
authenticated inventory (now binding expected count + `completeness`) is
published LAST as the commit marker; `scripts/backup.sh` refuses a db-only
"complete" backup for an s3 store and verifies media before printing
completion. (2) The s3 media path is **wired into `validate:recovery`** (no
manual out-of-gate command). (3) A single **`validate:deploy`** orchestration
fixes the migration/config ordering (config-safety before any migration). (4)
The synthetic-session lifecycle is **explicit and recovers** from a bootstrap
that created an account but failed to log in, and approach A now **revokes +
proves** the supplied session dead. (5) The MinIO drill is **mandatory in
CI**. (6) Evidence-retention errors are **sanitized** and `meta.json` is
**HMAC-authenticated**. (7) Store-identity fingerprints are **canonicalized**
so endpoint/case/slash aliases cannot bypass separation.

## 1. Why the original S3-media recovery plan was incomplete

`scripts/backup.sh` tarred the media store only when `NOVA_MEDIA_FS_ROOT`
existed. An S3/R2 deployment therefore backed up the DATABASE but silently
relied on *unverified provider bucket controls* for media — meaning the
proposed R2 architecture could not truthfully execute a complete isolated
recovery drill, and `validate:recovery`'s media step would have depended on
resources no drill had proven.

## 2. How it was closed (executable, tested)

Three operator commands built on the existing `ObjectStore` abstraction
(MinIO locally — the same client/path R2 uses in production):

| Command | What it does |
|---|---|
| `media:backup-s3 -- --stamp=<s> --out=<dir> [--apply]` | copies every DB-referenced encrypted blob AS STORED (never decrypted, no plaintext ever) from the primary store into a SEPARATE backup store under `media/<stamp>/`, and writes an **HMAC-authenticated inventory** (`NOVA_BACKUP_KEY`; object count, encrypted bytes, per-object sha256, source-fingerprint, timestamp, roles) to `--out` and into the backup store. Dry-run by default; idempotent/resumable on re-run; aliasing (source==destination) refused; console prints counts only — never object keys or content |
| `media:verify-backup-s3 -- --stamp=<s> [--dir=<dir>]` | authenticates the inventory (wrong key or ANY tampering fails closed), then verifies every object's size + sha256 in the backup store. Read-only; exit 2 on failure |
| `media:restore-s3 -- --stamp=<s> [--dir=<dir>] [--apply]` | verifies first, then copies blobs into the CONFIGURED (scratch) media store at their ORIGINAL keys so restored DB references resolve. Refuses aliased destinations and the ORIGINAL primary (fingerprint match; `NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes` only for true disaster recovery). Re-verifies every written object |

`scripts/backup.sh` now invokes `media:backup-s3 --apply` automatically when
`NOVA_MEDIA_STORE=s3` and `NOVA_BACKUP_S3_BUCKET` is set, publishing the
inventory next to the sealed DB artifacts — and fails loudly (backup
INCOMPLETE) instead of silently skipping media. Bucket versioning/replication
is no longer relied upon anywhere.

**Proof.** The `media-s3` unit suite (17 tests, in-memory stores) covers:
successful backup, successful restore, missing object, altered object, altered
inventory (MAC), wrong backup key, source/destination alias + primary-
destination refusal (incl. AWS-endpoint-respelling aliases, M18A.1 review),
interrupted/idempotent rerun, empty media set, dry-run write-free, and
secret/content-free inventory output. An 8-test integration drill against
**real MinIO** executes the complete sequence: synthetic encrypted media →
primary bucket → backup bucket + inventory → wrong-key/tamper proofs →
scratch DATABASE (real migrations + row copy; the sealed pg_dump/pg_restore
path keeps its own coverage via `scripts/restore.sh` + `validate:recovery`) →
media restore into a separate scratch bucket → media:verify equivalence
(every referenced blob present AND decryptable) → **mandatory post-restore
synthetic smoke: the real `runSmoke` walk over HTTP against the scratch
stack** → primary/scratch separation proof (primary bucket byte-identical
after the drill) → full local cleanup. CI now starts a MinIO container so
the drill runs on every PR; the suite skips itself only where MinIO is
genuinely unavailable.

## 2.1. Sealed database-backup persistence off-box (M18A.2 §3)

`scripts/backup.sh` seals the DB dump (and, when present, the media tar), the
authenticated manifest, and the s3 media inventory — but into a LOCAL
directory that a Render one-off job discards at teardown. Three thin commands
on the existing `ObjectStore` abstraction publish/fetch the COMPLETE sealed set
without a persistent disk:

| Command | What it does |
|---|---|
| `backup:publish-s3 -- --dir=<sealed-dir> --stamp=<s> [--apply]` | verifies the LOCAL sealed backup first, uploads every artifact to `sealed-backups/<stamp>/`, RE-READS + hashes each destination object, then publishes an **HMAC-authenticated commit marker LAST** binding the stamp, every artifact name + ciphertext sha256 + size, the sealed-manifest hash, the media-inventory hash (when applicable), the expected artifact count, completeness, creation time, and source/destination roles. Dry-run by default; idempotent; no plaintext uploaded; counts-only output |
| `backup:verify-s3 -- --stamp=<s>` | authenticates the remote marker (wrong/absent key or ANY tampering fails closed) and re-hashes every remote object. Read-only; exit 2 on failure |
| `backup:fetch-s3 -- --stamp=<s> [--out=<dir>]` | fetches ONLY a committed set: authenticates the marker, downloads into a private **0700** temp dir (removed at exit unless `--out` is given for a subsequent restore step), verifies sizes/hashes, and runs `backup:verify` — failing BEFORE restore on any missing/altered artifact |

`scripts/backup.sh` runs publish + remote-verify automatically when
`NOVA_BACKUP_PUBLISH_S3=yes` (fail-closed if `NOVA_BACKUP_S3_BUCKET` is unset).

**Backup job:** `scripts/backup.sh` → local verify → remote publish → remote
verify → evidence retention (M18A.3 §4: completion is stated as durable off-box
only after the remote verify; `NOVA_BACKUP_REQUIRE_OFFBOX=yes` fails a local-only
seal closed). **Recovery job (no persistent disk required):** the whole sequence
is ONE command — `pnpm validate:recovery-remote -- --stamp=<s>
--restored-base-url=<url> [--invite=<code>]` (M18A.3 §3) — which does
`backup:fetch-s3` a committed set into a fresh private 0700 workspace → verify →
DB restore (via `restore.sh` in `authorized-scratch` mode, the same guard the
gate validated) → s3 media restore → `media:verify` → post-restore smoke, and
ALWAYS removes the workspace afterward.

**Proof.** An 11-test unit suite (in-memory store) covers publish→verify→fetch
round-trip, no-plaintext-uploaded, wrong-key/no-key, missing artifact, altered
artifact, altered marker, dry-run write-free, interrupted-without-marker,
idempotent rerun, unsafe-stamp (path-traversal) refusal, and local-verify-
before-upload. A 3-test MinIO integration drill proves the same against a
**real S3 API**, including the fetch CLI's 0700 temp dir being removed at exit
and a refusal to fetch an uncommitted (marker-deleted) set.

## 2.2. No-false-PASS synthetic cleanup (M18A.2 §2)

The postdeploy in-gate synthetic session (§5) may only report a passing cleanup
with AFFIRMATIVE evidence that nothing remains. An ambiguous signup response is
`account_state_unknown` and cleanup FAILs if it cannot recover-delete-and-prove
(no more "likely no orphan"); post-delete proof and approach-A revocation both
require an exact HTTP 401. See §5.

## 3. In-network Validation Gate execution model (Render)

Postgres and Key Value stay private (`ipAllowList: []`); no gate ever
requires opening public datastore access.

| Gate | Where it executes | Datastore access | Notes |
|---|---|---|---|
| `validate:deploy` (M18A.1) | Render **pre-deploy command** of the API service (`preDeployCommand: pnpm validate:deploy`) — after image build, inside Render, before the new version takes traffic | internal `DATABASE_URL`/`REDIS_URL` | The SINGLE deploy orchestration, in strict order: pure config-safety FIRST (an unsafe config FAILs and cascade-skips the migration — migrations are NEVER applied under unsafe config) → operator prerequisites → **db:migrate (once)** → ops:preflight → **db:migrate:status (explicit 0-pending confirm)**. FAIL/BLOCKED exits non-zero → deploy aborted. No `db:migrate && validate:predeploy` — one command, no duplicated migration logic. Render's pre-deploy timeout (30 min) comfortably covers it. (`validate:predeploy` still exists for a no-migrate config-safety pre-check.) |
| `validate:postdeploy` | Render **one-off job** based on the API image (`render jobs` / dashboard), terminating automatically | none directly — only the PUBLIC API URL + the approved secret env | Creates its own synthetic session in-gate (§5), runs readyz/authed-status/smoke, uploads sanitized evidence (§4), exits |
| `validate:recovery` | separate one-off job / temporary restored API+worker stack (preceded by `backup:fetch-s3` of a committed sealed set — §2.1) | scratch `DATABASE_URL` (loopback **or** an explicitly-authorized remote scratch — see below), scratch `REDIS_URL` (if needed), scratch media bucket, backup bucket READ, restored-stack URL, synthetic invite via env | **No write access to the primary database or primary media bucket**; the only primary-adjacent permission is narrowly-scoped read on the backup bucket. The scratch guard (`backup:scratch-guard`) admits an authorized remote managed Postgres via the `NOVA_RESTORE_*` envelope (§2, M18A.2 §1) and BLOCKs `NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes`. For s3 stores the gate RUNS the media path in-band (M18A.1): `s3_recovery_prerequisites` (scratch ≠ backup, BLOCKED before mutation) → `media:verify-backup-s3` (+ wrong-key expected failure) → `media:restore-s3 --apply` into scratch → `media:verify` → post-restore smoke. The restore CLI additionally refuses primary-fingerprint destinations |

**Credential/IAM separation (names only):**
- primary stack: media-bucket credential (rw on `nova-media` only) + backup-bucket credential (write for `media:backup-s3` + evidence prefix).
- recovery job: scratch-bucket credential (rw on scratch bucket only) + backup-bucket READ credential; scratch `DATABASE_URL`; never the primary DSN.
- evidence uploads: the backup-bucket credential, `validation-evidence/` prefix.
R2 API tokens are created per-bucket-scope at provisioning time (an explicit provisioning step, not an assumption).

## 4. Validation-report retention (ephemeral-job survival)

`tools/validation-gate` now uploads the sanitized `report.json`,
`report.md`, `junit.xml`, plus a `meta.json` (run id, mode, outcome, git
sha, per-file sha256) to `validation-evidence/<mode>/<run-id>/` in the
private evidence store when `NOVA_VALIDATE_EVIDENCE_S3_*` is configured
(typically the separately-scoped backup bucket — never public). Properties:
sanitized reports only (no raw logs, secrets, captured content, or
session/invite values — enforced upstream by the sanitizer + tests); hashes
recorded and echoed so evidence is tamper-evident; **upload failure prints
`EVIDENCE RETENTION FAILED` and is never silently claimed as retained**;
`NOVA_VALIDATE_EVIDENCE_REQUIRED=yes` escalates the failure into the exit
code. Unit tests cover hash correctness, failure visibility, and
env-value-free metadata; the MinIO drill proves identical put/get semantics
on a real S3 API.

## 5. Synthetic validation session lifecycle (approach B implemented)

`NOVA_VALIDATE_SESSION_TOKEN` is no longer an operator burden: the postdeploy
gate **bootstraps its own synthetic session in-process**:

1. `synthetic_session_bootstrap` (required): signs up a unique synthetic
   account (`validate-<runid>@nova-validate.invalid`) with the approved
   invite, logs in, and holds the token ONLY in process memory
   (`ctx.runtime`); token + password are registered as sanitizer
   extra-secrets, so they can never reach argv, reports, or logs.
2. `ops_status_authed` (required, unchanged 3-layer leak detection) consumes
   the in-memory token.
3. `synthetic_session_cleanup` (required, **alwaysRun** — a new runner
   capability: cleanup is never cascade-skipped) deletes the account through
   the REAL deletion flow (password + typed DELETE, which revokes every
   session) and then PROVES cleanup by requiring the deleted credentials to
   stop authenticating. A cleanup failure is a FAIL, never silent.

Approach A still works: a pre-supplied `NOVA_VALIDATE_SESSION_TOKEN` creates no
account, but cleanup does NOT pass it through — it **REVOKES the token
(`/v1/auth/logout`) and PROVES it dead**, requiring an exact HTTP 401 on a
re-probe (403/5xx/unreachable → FAIL). "Nothing to clean" is reserved for the
case where bootstrap never transmitted a signup at all.

**Cleanup invariant (M18A.2 §2): a cleanup may PASS only with affirmative
evidence that no synthetic account or live session remains.** An ambiguous
signup (timeout / network loss / 5xx / malformed / any non-definitive response)
is `account_state_unknown`; cleanup attempts bounded recovery, deletes, and
proves the credentials dead — and FAILs (with the safe synthetic handle for
manual verification; postdeploy approval stops) if it cannot. Post-delete proof
requires exactly HTTP 401. Tests (against a real local HTTP server, 18 cases):
success-path cleanup, cleanup after mid-validation failure, login-failure
recovery, committed-but-lost-signup recovery, unrecoverable-ambiguous-signup
FAIL, delete-then-proof-401 PASS, delete-then-proof-500/timeout FAIL,
approach-A revoke-and-prove (401 PASS; 403/5xx/unreachable FAIL),
token/password/invite absent from every report, rerun idempotency, and loud
cleanup failure.

## 6. Render deployment specification (draft, NOT synced)

`infra/deploy/render.yaml` — validated against the official
`render.com/schema/render.yaml.json` (jsonschema; zero errors). Contents:
paid API web service (docker, `/readyz` health check, `preDeployCommand: pnpm
validate:deploy`), paid background worker, `basic-256mb` Postgres 16
(pgvector via the migrations; verified at provisioning), `starter` Key Value
(Valkey 8 — drop-in Redis; `maxmemoryPolicy: noeviction`; private only), NO
web frontend service initially, no domain, no DNS, no autoscaling, region
`virginia`, `autoDeployTrigger: "off"` everywhere, private `ipAllowList: []`
on both datastores, and environment-variable NAMES only (`sync: false`).
**Deployment assumption (observed, not a production capacity claim):**
`basic-256mb` must run the Nova migrations + pgvector at synthetic scale —
verified locally against Postgres 16 with default memory settings; confirmed
for real during M18 provisioning before first deploy, with the plan bumped
only if migration or preflight fails on resources.

One open image consideration recorded honestly: the current Dockerfiles keep
the full workspace (pnpm + sources) in the image, which is what makes
`preDeployCommand: pnpm validate:deploy` executable — acceptable for the
controlled synthetic deployment; image slimming is deferred and must keep the
gate runnable.

## 7. Exact cost verification procedure (no-write; run before provisioning)

From the Render dashboard/pricing page and Cloudflare dashboard, WITHOUT
creating anything, record: API Starter monthly price · worker Starter
monthly price · `basic-256mb` Postgres compute · minimum Postgres storage
charge · Key Value Starter monthly price · any minimum storage charges ·
per-second/prorated billing confirmation for temporary recovery resources ·
included build minutes + bandwidth and overage rates. Then: **sum the fixed
recurring total and compare against the authorized monthly cap BEFORE
confirming creation.** If the projected recurring cost exceeds the cap: do
not provision; report the exact non-secret price breakdown; request new
authorization. Verified anchors already on file (July 2026, official
sources): Hobby workspace $0/mo (5 GB bandwidth incl., $0.15/GB overage);
Postgres storage $0.30/GB-mo; Render's own example "always-on Starter web
service + Basic-256mb Postgres ≈ $13/month"; R2 $0.015/GB-mo, Class A
$4.50/M, Class B $0.36/M, 10 GB + 1M/10M ops free monthly, zero egress.
Unverified until the dashboard check: exact Starter/worker and Key Value
Starter prices.

## 8. Revised architecture recommendation (proposed — NOT yet approved)

Provider **Render + Cloudflare R2** · region **Virginia** (fallback
**Ohio**) · budget cap proposal **$60/month** · temporary recovery
resources **recommended approved** · web app service **deferred (no)** ·
data residency **United States** · autoscaling off · no domain · no public
Postgres/Key Value · R2 Standard storage · separate primary-media,
backup/evidence, and scratch destinations.

## 9. What remains unverified until real infrastructure exists

Real Render deploy behavior (pre-deploy command runtime, image build time),
actual dashboard prices, R2 token scoping ergonomics, real-network latency
metrics, cost baseline, real backup/restore on provider infrastructure, and
everything `validate:predeploy/postdeploy/recovery` measures — the gates
remain honestly BLOCKED until then. Real alpha stays NOT APPROVED.
