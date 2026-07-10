# M14 — Private Alpha Execution Record

This is the execution record for the first real alpha run: what was
actually executed (a full production-mode dress rehearsal on 2026-07-10,
evidence below), what is blocked on real infrastructure, the exact
sequences for the operator, the 7-day operating loop, and the gate
decision.

**Status: REHEARSED, NOT DEPLOYED.** No cloud credentials exist in the
build environment, and nothing below pretends otherwise. Every command,
check, and recovery path was executed for real against a
production-configured local stack instead.

**HARD GATE: no real user data until the operator explicitly approves the
alpha start.** See §9.

---

## 1. Blockers for the real deploy

| # | Blocker | What the operator must do |
|---|---|---|
| 1 | No hosting account/credentials | Pick a host (Fly.io assumed by `infra/deploy/*`; any Docker host works) and authenticate (`fly auth login`) |
| 2 | No managed Postgres | Provision Postgres 16 **with pgvector** (Fly Postgres/Neon/Supabase); note `DATABASE_URL` |
| 3 | No managed Redis | Provision Redis (Upstash/Fly Redis); note `REDIS_URL` |
| 4 | No production media storage decision | s3-compatible bucket recommended (`NOVA_MEDIA_S3_*`); fs needs a persistent volume |
| 5 | No production secrets minted | Generate `NOVA_ENCRYPTION_KEY` (`openssl rand -hex 32`) + `NOVA_ALPHA_INVITE_CODE` (`openssl rand -hex 12`); store in a secret store — the key is unrecoverable-loss-critical |
| 6 | No domains/TLS | Two public hostnames (web, api) with platform-terminated TLS; API URL goes into the extension + web `NOVA_API_URL` |
| 7 | No trusted-user agreement | Confirm the first user has read `docs/ALPHA_GUIDE.md` and consents |

Nothing else blocks: every command in the sequence below is implemented,
tested in CI, and was executed in the rehearsal.

## 2. Execution plan (operator sequence)

Target: three Fly apps (api, worker, web) + managed Postgres + Redis +
media bucket, per `infra/DEPLOY.md` (env tables, secrets checklist,
HTTPS assumptions all live there; runbooks in `docs/RUNBOOKS.md`).

```bash
# A. Provision (blockers 1-6), then:
export DATABASE_URL=... REDIS_URL=... NOVA_ENCRYPTION_KEY=... \
       NOVA_ALPHA_INVITE_CODE=... NODE_ENV=production \
       NOVA_MEDIA_STORE=s3 NOVA_MEDIA_S3_BUCKET=... # etc.

# B. Preflight — MUST print PREFLIGHT OK (fails closed on foot-guns):
pnpm --filter @nova/api ops:preflight

# C. Backup readiness BEFORE first real data:
scripts/backup.sh /backups/pre-alpha        # baseline dump (empty is fine)

# D. Deploy (API first — release step runs migrations 0000→0012):
fly secrets set -c infra/deploy/fly.api.toml DATABASE_URL=... REDIS_URL=... \
  NOVA_ENCRYPTION_KEY=... NOVA_ALPHA_INVITE_CODE=... NOVA_GIT_SHA=$(git rev-parse --short HEAD)
fly deploy -c infra/deploy/fly.api.toml     # gate = /readyz (M13)
fly deploy -c infra/deploy/fly.worker.toml
fly deploy -c infra/deploy/fly.web.toml

# E. Smoke — MUST print SMOKE OK (degraded only where config says):
pnpm --filter @nova/api ops:smoke -- --base-url=https://<api-host> --invite=$NOVA_ALPHA_INVITE_CODE
pnpm --filter @nova/api ops:maintenance     # dry run — sane zeros on a fresh DB

# F. STOP. Report readiness to the operator. Real user data only after
#    explicit approval (§9). Then onboard per §5.
```

**Rollback triggers** (execute `docs/RUNBOOKS.md` §Rollback):
- `/readyz` not green within the deploy grace period;
- `ops:smoke` prints any ✗ step;
- worker heartbeat absent >5 min with jobs queued;
- any privacy-category feedback or suspected content leak → also disable
  capture-side cloud features (unset keys / `NOVA_LIVE_QA=off`, redeploy)
  and triage before resuming.

## 3. Pre-deploy verification — REHEARSED, evidence

Rehearsal setup: fresh `nova_alpha` database (migrations 0000→0012), fresh
media root, `NODE_ENV=production`, generated 32-byte key, invite-only
signup, real API + worker processes from built `dist/`, real Tesseract OCR.

`ops:preflight` (production mode) — all checks green:

```
nova preflight — mode=production
  ✓ env / encryption_key / signup_policy — signup=invite
  ✓ screenshot_storage / redaction / notion — not configured (off)
  ✓ cloud_features — live_qa=off (no key) transcription+embeddings=off analytics=local
  ✓ postgres / migrations / redis / media_store — fs / sessions
PREFLIGHT OK
```

Fail-closed proofs (each exits 1):

```
NOVA_SIGNUP=open (production)      → ✗ signup_policy … PREFLIGHT FAILED
no NOVA_ENCRYPTION_KEY (production)→ ✗ env — NOVA_ENCRYPTION_KEY is required … PREFLIGHT FAILED
NOVA_REDACTION=off (production)    → ✗ env — requires NOVA_ALLOW_UNSAFE_REDACTION=yes … PREFLIGHT FAILED
```

## 4. Post-deploy smoke — REHEARSED, evidence

`ops:smoke` against the production-mode stack (real worker, real OCR):

```
✓ readyz ✓ signup ✓ login ✓ extension_pairing ✓ instant_capture
✓ visual_redaction ✓ media_storage ✓ task_creation ✓ timeline ✓ search
~ live_qa — disabled by config (no key or NOVA_LIVE_QA=off)
✓ save_from_live ✓ approval_queue ✓ notion_status ✓ export
✓ worker_processing ✓ delete_moment ✓ audit_log ✓ status_page
✓ worker_heartbeat ✓ account_delete
SMOKE OK
```

Synthetic content only (generated nonce + 1×1 white PNG); the synthetic
account deleted itself through the real deletion flow.
`ops:maintenance` (dry run) followed: all sections zero on the fresh DB.

**Findings the rehearsal caught (both fixed in this milestone):**

1. **Corrupt-image API crash.** A malformed PNG in a capture crashed the
   whole API process: tesseract.js's worker thread rethrows libpng errors
   out of band (`process.nextTick`), bypassing the promise-level fail-safe.
   Fix: `TesseractOcrEngine` now Jimp-decodes and re-encodes every image
   before OCR — hostile bytes fail as a normal redaction failure (strict
   mode drops the image: verified `blocked_strict`, media 0; the API stayed
   up under replay). Regression-pinned in `src/ocr.test.ts`. Also moved
   `jimp` to production dependencies (it was dev-only while production code
   imported it — a latent `--prod` install failure).
2. **Smoke misread enrichment success.** The worker reports
   `enrichment_status=completed`; smoke expected `done` and mislabeled a
   healthy worker as degraded. Fixed in `ops/smoke.ts`.

## 5. Backup and restore — REHEARSED, evidence

```
scripts/backup.sh <dest>                     → nova-db-<stamp>.dump + nova-media-<stamp>.tar.gz
scripts/restore.sh <dest> <stamp>            → into a scratch DB + scratch media root
  db:migrate                                 → no-op (schema current)
  media:verify (correct key)                 → 2 rows: verified 3, missing 0, undecryptable 0 ✓
media:verify (WRONG key)                     → verified 0, undecryptable 3, exit 2 ✓
```

The wrong-key run is the "what cannot be restored without keys" proof:
metadata restores, media/tokens stay ciphertext, and verification fails
loudly instead of pretending. No secrets exist in any backup artifact
(backup.sh prints the reminder; the tar+dump were inspected).

## 6. First-user onboarding package

User-facing: `docs/ALPHA_GUIDE.md` (account, consent, extension install +
pairing, first capture, live test, optional Notion, export/delete, bug
reporting, honest privacy limitations, **emergency stop**).

Operator sequence:

1. `ops:smoke` green on the target (§4) + operator approval recorded (§9).
2. Send the user: web URL, the invite code (out of band), the extension
   zip (`pnpm --filter @nova/extension zip`), and the guide link.
3. User completes guide §§1–4 (signup → consent → pair → first capture);
   operator watches `/status` and the audit page during the first session.
4. Recommend **strict redaction ON** in extension settings for the alpha
   (fail-closed images; the rehearsal's corrupt-image finding is why).
5. First feedback item filed (any category) proves the intake path.

## 7. The first 7-day loop

Daily (5 minutes, commands from `docs/RUNBOOKS.md`):

- `ops:smoke -- --base-url=… --invite=…` — green? (degraded list unchanged?)
- `ops:report -- --days=1` — usage counts moving? `capture_failed`?
  warnings empty? **privacy feedback = incident, triage first**;
- `/status` — worker heartbeat fresh, queues drained, failed jobs 0;
- note in the decision log (below): search quality, capture failures,
  live-context behavior, Notion behavior (if enabled later).

Weekly: `ops:maintenance` (review, then `--apply`), `scripts/backup.sh`,
feedback triage (`UPDATE alpha_feedback SET status='triaged' …`), storage
review vs `NOVA_MEDIA_WARN_MB`.

Decision log — append one line per day to the operator's copy of this file:

| Day | Smoke | Report warnings | Friction noted | Decision/action |
|---|---|---|---|---|
| 1 | | | | |
| … | | | | |
| 7 | → feeds the M15 decision | | | |

## 8. Alpha report format

`ops:report` (JSON) covers: usage counts (`events`, `usage`), failures
(`friction` incl. recent failed-action reasons), queue/worker health (via
`/v1/ops/status` `queues`/`worker`/`warnings`), storage usage + media
delete queue (`usage`, `warnings`), feedback categories
(`feedback_by_category` + excerpts), top friction points (the `friction`
block ordered by count), privacy/security incidents (privacy-category
feedback escalates to a PRIVACY warning; security events live in the audit
log by name). Recommended fixes = operator judgement recorded in the
decision log. Nothing in the report can contain captured content —
verified by test.

## 9. Gate decision (end of M14)

| Decision | Position | Basis |
|---|---|---|
| Proceed with alpha usage? | **YES, pending infrastructure + explicit operator approval** | rehearsal green end to end; two real defects found AND fixed |
| Pause for fixes? | No — nothing open | both rehearsal findings fixed + regression-pinned |
| Rollback? | n/a — nothing deployed | |
| Disable risky features? | Keep **live Q&A, cloud enrichment, transcription OFF** at alpha start (no keys configured); enable one at a time later, each is a single env change | cost + privacy blast-radius control |
| Extension as primary surface? | **Yes** | unchanged M12 evidence |
| Browser-shell? | **Defer** (manual testing only if the extension shows limits) | M12 gates unchanged |
| Notion? | **Start disabled**; enable only after the gated live smoke (`notion-live-smoke.test.ts`) passes against a real workspace | fake-provider path is CI-pinned, live path never exercised |
| Strict image redaction for the alpha user? | **Recommend ON** | corrupt/undecodable images then fail closed (`blocked_strict`) |

**READINESS STATEMENT: Nova Context is ready for a real private alpha the
moment the §1 blockers are provisioned. Every operator command has been
executed for real in a production-shaped rehearsal. Per the M14 gate, the
alpha does NOT start — and no real user data is captured — until the
operator explicitly approves.**
