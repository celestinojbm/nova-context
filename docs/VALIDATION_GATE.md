# Validation Gate v0 (M17B)

A **thin orchestration layer** over the validation Nova Context already has.
It exists to answer one question consistently — *go or no-go?* — with honest
semantics, machine-readable reports, and a safe entry point for future
real-infrastructure validation. It is **not** the full Validation Harness v1
(see "Deferred to v1" below), and it does **not** prove production readiness.

## Why v0, and why thin

By M17B the repo already validates itself substantially: monorepo build +
typecheck; unit suites (schema, context-engine, model-router, extension,
browser-shell, api, worker); Postgres+Redis integration suites covering
authentication, cross-user isolation, prompt-injection/adversarial security,
visual redaction, media safety/access, export/delete lifecycle, and the
backup/restore guard CLIs; migrations in CI; `ops:preflight`, `ops:smoke`,
`ops:report`, `media:verify`, `backup:verify`, `backup:restore-guard`; and a
GitHub Actions pipeline running the whole sequence.

**Architectural decision:** the missing piece was never more tests — it was
coordination. So Validation Gate v0 (`tools/validation-gate/`) *invokes* the
existing aggregate commands and *never reimplements* auth, migrations, media
encryption, redaction, lifecycle, backup/restore, smoke, preflight, security
or isolation logic. What it adds:

- one **outcome vocabulary** (`PASS / CONDITIONAL_PASS / FAIL / BLOCKED`);
- honest **BLOCKED** detection (missing operator infra is not a pass and not
  a test failure);
- **reports** — JSON + Markdown + JUnit per run;
- **sanitization** — no secret or captured content can reach a report;
- **expected-failure** support (e.g. wrong-key `backup:verify` must fail);
- a CI go/no-go with per-check visibility.

What it deliberately does **not** add: new product tests, performance SLAs,
load/chaos tooling, or anything that duplicates an existing suite.

## Modes

| Command | Purpose | Needs | Current environment result |
|---|---|---|---|
| `pnpm validate:pr` | PR/merge gate: `build → typecheck → test → db:migrate → test:integration` | local/CI Postgres+Redis only — no cloud creds, ever | **PASS** when repo checks pass |
| `pnpm validate:predeploy` | production posture + operator prerequisites + `ops:preflight` | `NODE_ENV=production` + operator secrets (names checked, values never printed) | **BLOCKED** (no sanctioned real infra) |
| `pnpm validate:postdeploy -- --base-url=… [--invite=…]` | `/readyz`, **mandatory** authed `/v1/ops/status` (`NOVA_VALIDATE_SESSION_TOKEN`), synthetic `ops:smoke` | a REAL deployed Nova API + invite for the self-deleting synthetic account + operator session token | **BLOCKED** (no real deployment) |
| `pnpm validate:recovery -- --backup-dir=… --stamp=… --restored-base-url=… [--invite=…]` | `backup:verify` (+ expected wrong-key failure) → guarded scratch restore → migrate no-op → `media:verify` → **mandatory** post-restore smoke against the restored scratch stack | sealed backup, `NOVA_BACKUP_KEY`, `NOVA_ENCRYPTION_KEY`, a SCRATCH `DATABASE_URL`, the restored stack's loopback URL, a synthetic invite (`--invite` or `NOVA_SMOKE_INVITE`) | **BLOCKED** (no sanctioned backup/scratch target) |

### Gate-integrity guarantees (M17B.1)

- **Pre-deploy safety runs even when infrastructure is incomplete.** Pure
  configuration checks (config safety, feature posture, prerequisite
  presence) inspect only the local environment and always execute — an
  environment with `NOVA_SIGNUP=open`, redaction off, the unsafe override,
  or identical encryption/backup keys is **FAIL** even when `DATABASE_URL`
  or other infrastructure values are missing (FAIL > BLOCKED). Only the
  non-pure `ops:preflight` cascades: it never runs when prerequisites are
  missing.
- **Authenticated `/v1/ops/status` is mandatory for a post-deploy PASS.**
  `NOVA_VALIDATE_SESSION_TOKEN` is a hard prerequisite (missing → BLOCKED),
  the check is `required`, and it validates three layers: the JSON-object
  response contract, explicit raw-infrastructure/captured-content patterns
  (`ECONNREFUSED`, `ENOTFOUND`, `AccessDenied`, `data:image` any case, …),
  and the sanitizer diff for secret shapes. Failure or leak → FAIL.
- **Post-restore smoke is mandatory for a recovery PASS.** The
  `--restored-base-url` (loopback, or explicitly acknowledged via
  `NOVA_VALIDATE_ALLOW_REMOTE_RESTORED=yes` for an authorized scratch host)
  is a hard prerequisite — missing → BLOCKED; unreachable restored stack or
  failing smoke → FAIL. Recovery can never PASS without functionally testing
  the restored system. The smoke's **synthetic invite** (`--invite` or
  `NOVA_SMOKE_INVITE`) is likewise a hard prerequisite — missing invite is an
  honest BLOCKED (named, never valued), not a smoke FAIL — and is handed to
  `ops:smoke` only through the child-process environment, never argv, so it
  cannot appear in command descriptions, evidence, or reports.
- **Structured skip provenance.** Skips carry typed fields
  (`skip_reason: cascade | explicit_optional | not_applicable`,
  `caused_by_check_id`) — never free-text inference. A REQUIRED check may be
  skipped only as a `cascade` from an earlier failed/blocked required check
  that exists in the same report; anything else is BLOCKED. Optional
  explicit skips stay non-blocking.

The PR sequence's aggregates already include every required suite (unit:
schema/context-engine/model-router/extension/browser-shell/api/worker;
integration: auth, auth-hardening, isolation, security/prompt-injection,
visual-redaction, media/media-ops, account-lifecycle export/delete,
alpha-blockers, backup/restore-guard CLIs, worker queue tests) — so the gate
runs the aggregates, never a hand-maintained file list.

Safety invariants baked into the modes: post-deploy uses **synthetic data
only** (the smoke account self-deletes; no real user data, ever); recovery
**never restores over production** — `backup:scratch-guard` (M18A.2) must
classify the target as local scratch (loopback + non-production) OR an
explicitly-authorized remote scratch (the full `NOVA_RESTORE_*` envelope) or
the gate blocks before any mutation; the backup is verified **before** any
destructive restore step; raw DSNs and keys are never printed.

### M18A.1 gate-integrity corrections

- **`validate:deploy` mode** — the single Render pre-deploy orchestration:
  pure config-safety FIRST (unsafe config FAILs and cascade-skips the
  migration), then operator prerequisites, then `db:migrate` (once), then
  `ops:preflight`, then `db:migrate:status` (explicit 0-pending confirm).
  Migrations are never applied under an unsafe configuration; no duplicated
  migration logic.
- **S3 media wired into `validate:recovery`** — for s3 stores the gate runs
  `s3_recovery_prerequisites` (scratch ≠ backup → BLOCKED before mutation) →
  `media:verify-backup-s3` (+ wrong-key expected failure) → `media:restore-s3
  --apply` → `media:verify` → post-restore smoke, all required/protected. fs
  stores keep the tar path.
- **Atomic fail-closed s3 media backup** — two-phase (completeness scan →
  copy + destination re-verify → authenticated inventory published LAST as
  the commit marker); the verifier rejects incomplete/count-mismatched/
  wrong-HMAC/altered inventories.
- **Session lifecycle** — explicit states; the account is recorded the
  instant signup succeeds so cleanup can RECOVER a failed login and still
  delete it (or FAIL loudly with a sanitized synthetic handle — never
  "nothing to clean"); approach A REVOKES the supplied token and proves it
  dead.
- **Evidence** — upload errors are sanitized; `meta.json` is
  HMAC-authenticated with `NOVA_BACKUP_KEY` and uploaded last as the commit
  marker.
- **Identity fingerprints canonicalized** — endpoint case/port/slash and fs
  trailing-slash variants collapse, so aliases cannot bypass source/backup/
  scratch separation. The fingerprint is a safety guard, not proof of
  provider-account identity.

### M18A additions (pre-provision closure)

- **In-gate synthetic session (postdeploy, approach B).** The gate now
  bootstraps its own synthetic validation session: unique account via the
  invite → login → token held ONLY in process memory (registered as a
  sanitizer extra-secret, so it cannot reach argv, reports, or logs) → the
  mandatory authenticated `/v1/ops/status` check → `synthetic_session_cleanup`
  (required, **alwaysRun** — never cascade-skipped) deletes the account
  through the real deletion flow (revoking all sessions) and PROVES cleanup
  by requiring the dead credentials to stop authenticating. A pre-supplied
  `NOVA_VALIDATE_SESSION_TOKEN` (approach A) is still honored — no account is
  created, but cleanup **REVOKES the token and proves it dead** (exact 401);
  it does NOT pass through as "nothing to clean".
- **Evidence retention.** With `NOVA_VALIDATE_EVIDENCE_S3_*` configured, the
  sanitized `report.json`/`report.md`/`junit.xml` + a hash-bearing
  `meta.json` are uploaded to `validation-evidence/<mode>/<run-id>/` in the
  PRIVATE evidence store (ephemeral CI/Render-job filesystems lose local
  reports). Upload failure prints `EVIDENCE RETENTION FAILED` and is never
  silently claimed; `NOVA_VALIDATE_EVIDENCE_REQUIRED=yes` folds the failure
  into the exit code.
- **Render execution model.** `validate:deploy` runs as the API service's
  pre-deploy command (inside Render, internal DSNs, deploy aborts on
  FAIL/BLOCKED; NOT `validate:predeploy`, which remains a no-migrate
  config-safety pre-check mode); postdeploy/recovery run as one-off jobs with
  narrowly scoped env (recovery: scratch resources + backup-bucket read only). See
  `docs/M18_PREPROVISION_READINESS.md` §3.
- **S3 media recovery.** `validate:recovery`'s media path is now executable
  on S3/R2 stores via `media:backup-s3` / `media:verify-backup-s3` /
  `media:restore-s3` (encrypted-as-stored copies, HMAC-authenticated
  inventory, scratch-only restore). Proven end-to-end against MinIO in CI.

### M18A.2 additions (executable cloud recovery closure)

- **Authorized remote scratch database.** The recovery scratch guard
  (`backup:scratch-guard`, distinct from `restore.sh`'s `backup:restore-guard`)
  admits an explicitly-authorized remote managed Postgres in addition to local
  loopback. A remote target passes ONLY when the full `NOVA_RESTORE_*` envelope
  matches (allow-flag + `scratch` class + expected host/database/credential-free
  fingerprint + typed `NOVA_RESTORE_SCRATCH_CONFIRM` + a `NOVA_RECOVERY_RUN_ID` marker in
  the DB name + a fingerprint proven ≠ the primary). Any mismatch/absence/
  production → BLOCKED before mutation; a malformed DSN → FAIL. No generic
  remote-restore bypass; the guard prints only a credential-free target +
  names-only reasons. It also BLOCKs `NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes`
  (a drill must never overwrite primary).
- **No false-PASS synthetic cleanup.** A cleanup PASSes only with affirmative
  evidence: an ambiguous signup is `account_state_unknown` and FAILs if it
  cannot recover-delete-and-prove (no "likely no orphan"); post-delete proof and
  approach-A revocation both require an exact HTTP 401 (200/403/4xx/5xx/timeout
  → FAIL).
- **Sealed backup persistence off-box.** `backup:publish-s3` /
  `backup:verify-s3` / `backup:fetch-s3` publish the complete sealed set to a
  private `sealed-backups/<stamp>/` prefix bound by an HMAC-authenticated
  commit marker written LAST; fetch downloads a committed set into a private
  0700 temp dir, verifies, and runs `backup:verify` before restore — so a
  Render one-off recovery job needs no persistent disk.

## Outcomes

- **PASS** — all mandatory checks ran and passed.
- **CONDITIONAL_PASS** — all mandatory security/privacy/isolation/
  correctness/recovery checks passed, but an explicitly allowed optional
  capability is disabled or degraded (e.g. Notion/live-QA/cloud-enrichment/
  transcription intentionally OFF at first deploy). A disabled optional
  capability can never hide a failed mandatory check.
- **FAIL** — a required check ran and failed (build/typecheck/test failure,
  unsafe production config such as `NOVA_SIGNUP=open` or redaction off,
  preflight/smoke failure, backup-integrity failure, …).
- **BLOCKED** — the gate could not run because operator-controlled
  prerequisites do not exist (no infra, no deployment URL, no scratch
  target, missing credentials). **BLOCKED is never silently a pass**; it
  lists missing prerequisite *names*, never values. Missing infra is
  BLOCKED; *supplied-but-unsafe* config is FAIL.

**Check statuses:** `passed / failed / blocked / skipped / degraded`.
**Severities:** P0–P3. **Blocking rules:** failed P0/P1 → FAIL; failed
required P2 → FAIL; blocked mandatory prerequisite → BLOCKED; P3 failures
can yield CONDITIONAL_PASS **only** outside the protected categories
(security, privacy, isolation, adversarial, media, backup, recovery — these
are never optional); a deliberately disabled optional feature is `degraded`;
a skipped required check without a documented safe reason can never PASS.

**Exit codes:** PASS/CONDITIONAL_PASS → 0 (CI prints a warning note for
conditional); FAIL → 1; BLOCKED → 1 in PR mode (a gate that couldn't run
must not merge) and 2 in operator modes (distinct from FAIL: nothing broke,
prerequisites are missing).

## Reports

Every run writes (git-ignored, never committed):

```
artifacts/validation/<run-id>/report.json   # schema_version 1
artifacts/validation/<run-id>/report.md     # verdict, blocking reasons, checks, metrics
artifacts/validation/<run-id>/junit.xml     # one testcase per check
artifacts/validation/latest.json|latest.md  # convenience copies
```

JSON top-level: `schema_version, run_id, mode, git_sha, started_at,
finished_at, duration_ms, outcome, checks[], summary{}, blocking_reasons[],
warnings[], metrics{}`; each check carries `id, name, category, severity,
required, status, duration_ms, summary, evidence`.

Reports **never** contain: passwords, full DSNs, Redis credentials, S3 keys,
encryption/backup keys, invite codes, bearer/session tokens, cookies, API
keys, captured text, screenshots, `data:` URLs, media bytes, integration
tokens, or raw dependency errors with infrastructure details.

## Sanitization

`tools/validation-gate/src/sanitization.ts` is the single choke-point.
Everything that can reach a report (stdout/stderr excerpts, summaries,
blocking reasons, command descriptions, thrown errors) passes through it,
with two always-on layers: (1) exact-value redaction of known secret env
vars present in the environment, and (2) pattern-based redaction (DSN
credentials, bearer/cookie/session tokens, provider API-key shapes, 32-byte
hex keys, `data:` URLs of any case, private-key blocks) — so a secret that
never lived in our env is still caught. Marker: `[REDACTED]` /
`[REDACTED_DATA_URL]`. Full raw command output is never stored; streams are
capped to excerpts before sanitizing. A `--debug` flag echoes more (still
sanitized) evidence locally only — it is refused in CI and documented as
unsafe for sharing.

## Metrics

v0 records durations (total, per check) and parses vitest totals where
printed. Post-deploy/recovery modes record `/readyz` and status latencies,
smoke/backup/restore/media-verify durations. **No product-performance
p95/p99 SLAs exist in v0**: without a baseline, measurements are reported as
`observed`, non-blocking. The only hard v0 thresholds are the ones already
justified: per-check timeouts, `/readyz` must be `ready:true`, and
smoke/backup-verify/restore/media-verify/post-restore-smoke must succeed.
Calibrated performance and regression thresholds belong to Validation
Harness v1, after the first real synthetic deployment produces real numbers.

## Configuration

`tools/validation-gate/src/config.ts` defines, per mode: check order, ids,
categories, severities, required/optional, timeouts, commands, and
expected-exit behavior. No secrets live in configuration. Overrides:
`NOVA_VALIDATE_TIMEOUT_<CHECK_ID>=<ms>` per check,
`NOVA_VALIDATE_OUT_DIR=<dir>` for the report root,
`NOVA_VALIDATE_ALLOW_CLOUD=yes` to acknowledge an intentionally enabled
cloud feature at the pre-deploy gate (it still reports `degraded`, never
hides failures). CLI `--help` documents outcome semantics, prerequisites,
the no-real-user-data rule, and report locations.

## CI behavior

`.github/workflows/ci.yml` provisions Postgres (pgvector) + Redis, installs
with a frozen lockfile, and runs **`pnpm validate:pr`** — the gate runs the
sequence, CI does not additionally re-run the same steps (no duplication).
Reports upload as the `validation-report` artifact with `if: always()`, and
`latest.md` is appended to the job summary so the verdict and failing checks
are visible at a glance. No production secrets exist in PR workflows;
post-deploy/recovery modes are operator-invoked (a future
`workflow_dispatch` + protected-environment workflow may wrap them — not
enabled in M17B, and no deployment workflow exists).

## Operator prerequisites & connection to M17

`docs/M17_OPERATOR_INFRASTRUCTURE_PACKET.md` lists everything the operator
must supply. Once those exist: `validate:predeploy` must PASS (posture +
preflight) before deploying; `validate:postdeploy -- --base-url=…` runs the
synthetic smoke against the real deployment; `validate:recovery` drives the
sealed-backup → scratch-restore drill. Those three passing (with only
allowed degraded features) is the evidence trail for flipping M16's
DEPLOY-GATE from BLOCKED — followed by a Hermes delta re-audit before any
one-user alpha. Real alpha remains gated on explicit operator approval
regardless of gate outcomes.

## Troubleshooting (without exposing secrets)

- **BLOCKED** — read `blocking_reasons` in `latest.md`: they name missing
  prerequisites (env var names, flags). Supply them in your secret manager /
  CLI and re-run. Never paste values into the repo, a PR, or a report.
- **FAIL on a command check** — the JUnit artifact names the exact check;
  its `evidence` holds a sanitized output excerpt. Reproduce locally with
  the same underlying command (e.g. `pnpm test:integration`).
- **Timeout** — raise `NOVA_VALIDATE_TIMEOUT_<CHECK_ID>` if the environment
  is genuinely slower; timeouts are failures by design.
- **`--debug`** — local-only sanitized verbosity; refused in CI.

## Deferred to Validation Harness v1 (after the first real synthetic deploy)

Calibrated p95/p99 SLAs; load testing; browser-level end-to-end matrix;
long-running soak tests; chaos engineering; fault injection against real
infrastructure; multi-instance/multi-region tests; automatic historical
trend database; automatic comparison against previous release baselines;
resource/cost regression analysis; full production recovery automation;
scheduled recurring validation; real external-integration test matrix.

v1 stays premature until real infrastructure exists, preflight runs against
it, synthetic post-deploy smoke runs, real object storage and Redis/worker
behavior are exercised, a real backup/restore drill is executed, and real
latency data exists to calibrate thresholds from.

## What v0 proves (and doesn't)

It proves existing validation is centrally orchestrated with consistent
semantics, reports are generated, merges get an explicit go/no-go, and
future deployment validation has a safe entry point. It does **not** prove
production readiness — that requires the real-infrastructure gates above.
