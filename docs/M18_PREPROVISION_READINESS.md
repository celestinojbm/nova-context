# M18A — Pre-Provision Deployment & Recovery Closure

Status: **complete, awaiting provisioning authorization.** No external
resource has been created; no production secret exists; nothing is deployed;
no cost has been incurred; the Render Blueprint is committed but NOT synced.

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

**Proof.** 11 unit tests (in-memory stores) cover: successful backup,
successful restore, missing object, altered object, altered inventory
(MAC), wrong backup key, source/destination alias + primary-destination
refusal, interrupted/idempotent rerun, empty media set, dry-run write-free,
and secret/content-free inventory output. A 7-test integration drill against
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

## 3. In-network Validation Gate execution model (Render)

Postgres and Key Value stay private (`ipAllowList: []`); no gate ever
requires opening public datastore access.

| Gate | Where it executes | Datastore access | Notes |
|---|---|---|---|
| `validate:deploy` (M18A.1) | Render **pre-deploy command** of the API service (`preDeployCommand: pnpm validate:deploy`) — after image build, inside Render, before the new version takes traffic | internal `DATABASE_URL`/`REDIS_URL` | The SINGLE deploy orchestration, in strict order: pure config-safety FIRST (an unsafe config FAILs and cascade-skips the migration — migrations are NEVER applied under unsafe config) → operator prerequisites → **db:migrate (once)** → ops:preflight → **db:migrate:status (explicit 0-pending confirm)**. FAIL/BLOCKED exits non-zero → deploy aborted. No `db:migrate && validate:predeploy` — one command, no duplicated migration logic. Render's pre-deploy timeout (30 min) comfortably covers it. (`validate:predeploy` still exists for a no-migrate config-safety pre-check.) |
| `validate:postdeploy` | Render **one-off job** based on the API image (`render jobs` / dashboard), terminating automatically | none directly — only the PUBLIC API URL + the approved secret env | Creates its own synthetic session in-gate (§5), runs readyz/authed-status/smoke, uploads sanitized evidence (§4), exits |
| `validate:recovery` | separate one-off job / temporary restored API+worker stack | scratch `DATABASE_URL`, scratch `REDIS_URL` (if needed), scratch media bucket, backup bucket READ, restored-stack URL, synthetic invite via env | **No write access to the primary database or primary media bucket**; the only primary-adjacent permission is narrowly-scoped read on the backup bucket. For s3 stores the gate now RUNS the media path in-band (M18A.1): `s3_recovery_prerequisites` (scratch ≠ backup, BLOCKED before mutation) → `media:verify-backup-s3` (+ wrong-key expected failure) → `media:restore-s3 --apply` into scratch → `media:verify` → post-restore smoke. The restore CLI additionally refuses primary-fingerprint destinations |

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

Approach A still works: a pre-supplied `NOVA_VALIDATE_SESSION_TOKEN` is used
as-is (no account created; cleanup passes with "nothing to clean"). Tests
(against a real local HTTP server): success-path cleanup, cleanup after
mid-validation failure, token/password/invite absent from the entire report,
account deletion + session revocation proven, rerun idempotency (unique
account per run), approach-A passthrough, and loud cleanup failure.

## 6. Render deployment specification (draft, NOT synced)

`infra/deploy/render.yaml` — validated against the official
`render.com/schema/render.yaml.json` (jsonschema; zero errors). Contents:
paid API web service (docker, `/readyz` health check, `preDeployCommand: pnpm
validate:predeploy`), paid background worker, `basic-256mb` Postgres 16
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
`preDeployCommand: pnpm validate:predeploy` executable — acceptable for the
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
