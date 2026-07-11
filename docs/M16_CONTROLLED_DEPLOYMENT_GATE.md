# M16 — Controlled Real Deployment Gate

**M16 is NOT live alpha. M16 is NOT user-data capture. M16 is NOT product
expansion.** M16 prepares — and, if real infrastructure credentials were
available, would execute — a *controlled* deployment gate using **synthetic
data only**. Real alpha stays blocked behind the M14 hard gate and the full
checklist at the end of this document.

- **Branch:** `claude/m16-nova-context`
- **Base:** `main` @ M15 (`a4b75c2`) — contains M0–M15.
- **Did a real deployment happen?** **NO** — see "Deploy attempt" below.
- **Gate decision:** **C — DEPLOY-GATE BLOCKED** (deploy-ready, not deployed;
  real infrastructure credentials are not present in this environment). No P0
  or P1 found. Accepted P2/P3 residuals from M15 were hardened.

---

## 1. Deploy attempt — why no real deployment happened

A controlled real deployment requires provider credentials + managed
infrastructure that this environment does **not** contain. The only
cloud-shaped credentials present are a generic `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` pair that belong to the sandbox/agent runtime — they
are **not** a sanctioned Nova production deploy target, carry no Nova
Postgres/Redis/media/domain, and provisioning real infra from them would be
an unapproved, cost-incurring external action. Per the M16 rule
("if credentials are missing, do not pretend deployment happened") the gate is
**BLOCKED** and Nova stays **deploy-ready, not deployed**.

No secrets are printed in this document.

## 2. Infrastructure blocker checklist (operator must provide)

Each row is a hard blocker for the controlled deploy. `infra/DEPLOY.md` holds
the provider-specific commands; this is the value-provisioning checklist.
"Who" = who/what must supply the secret.

| # | Requirement | Concretely | Who | Status |
|---|---|---|---|---|
| 1 | Hosting provider auth | `fly` CLI authenticated (3 apps: api/worker/web) — `infra/deploy/fly.*.toml` | Operator | ⛔ missing |
| 2 | Production domain | e.g. `api.nova.example`, `app.nova.example` + DNS | Operator | ⛔ missing |
| 3 | HTTPS/TLS | Fly-managed certs (or provider equivalent) for the domains | Operator/provider | ⛔ missing |
| 4 | Managed Postgres **with pgvector** | `DATABASE_URL`; `CREATE EXTENSION vector` permitted (migration runs it) | Provider (Fly PG/Neon/Supabase) | ⛔ missing |
| 5 | Redis | `REDIS_URL` (plain connection string for BullMQ) | Provider (Fly/Upstash) | ⛔ missing |
| 6 | Media object storage | `NOVA_MEDIA_STORE=s3` + `NOVA_MEDIA_S3_*` (**prefer s3 in prod**; fs needs a persistent volume) | Operator (bucket + SSE + versioning) | ⛔ missing |
| 7 | Data encryption key | `NOVA_ENCRYPTION_KEY` = `openssl rand -hex 32` (**required in prod**) | Operator secret store | ⛔ missing |
| 8 | Backup seal key | `NOVA_BACKUP_KEY` = `openssl rand -hex 32` — **SEPARATE** from #7, never stored with backups | Operator secret store | ⛔ missing |
| 9 | Invite code | `NOVA_ALPHA_INVITE_CODE` = `openssl rand -hex 12` (**prod signup is invite-only**) | Operator | ⛔ missing |
| 10 | Backup destination | Access-controlled store **separate** from app hosts (private, versioned bucket) | Operator | ⛔ missing |
| 11 | Backup retention | ≥14 daily; prune whole `<stamp>` sets (`.enc` + manifest) — see RUNBOOKS §Backup policy | Operator policy | ⛔ missing |
| 12 | Worker deployment | `fly deploy -c infra/deploy/fly.worker.toml` (same `DATABASE_URL`/`REDIS_URL`/keys as API) | Operator | ⛔ missing |
| 13 | Environment variables | Per `services/{api,worker}/.env.example` (documentation of record) | Operator | ⛔ missing |
| 14 | Kill switches | `NOVA_SCREENSHOT_STORAGE=off` (drop media), `NOVA_REDACTION` on, `NOVA_IMAGE_REDACTION` on, `NOVA_LIVE_QA` off, `NOVA_CLOUD_ENRICHMENT` off — see §5 | Operator | ⚙ documented |
| 15 | Disabled-at-start features | Notion, cloud enrichment, live QA, transcription, external actions — all OFF unless synthetic-smoked (§5) | Operator | ⚙ documented |
| 16 | Rollback procedure | `fly releases` + `fly deploy --image <prev>`; DB is forward-only (see §Rollback) | Operator | ⚙ documented |

Until rows 1–13 are supplied by the operator, **no deploy runs**.

## 3. Controlled deploy runbook (execute WHEN infra is available)

Synthetic data only. Do not onboard real users. Exact commands:

```bash
# 0. Build (Dockerfiles do this per-service)
pnpm exec turbo build

# 1. Create apps once, set secrets (values from §2), deploy API first
fly deploy -c infra/deploy/fly.api.toml     # release_command runs migrations
fly deploy -c infra/deploy/fly.worker.toml
fly deploy -c infra/deploy/fly.web.toml

# 2. Preflight against REAL infra (must print PREFLIGHT OK, mode=production)
fly ssh console -c infra/deploy/fly.api.toml -C "node dist/db/run-preflight.js"

# 3. Readiness + authed status
curl -fsS https://<api-domain>/readyz            # booleans only, must be ready:true
#   authenticated GET /v1/ops/status with an operator session — degraded flags only

# 4. Smoke with SYNTHETIC content only (self-deleting synthetic account)
fly ssh console -c infra/deploy/fly.api.toml -C \
  "node dist/db/run-smoke.js --base-url=https://<api-domain> --invite=<code>"
#   walks capture→OCR/redaction→media store→worker→export→delete; ok|degraded|fail

# 5. Verify: OCR/redaction on synthetic screenshot; media store; worker;
#    export/delete of the synthetic account; logs+analytics carry NO content.
```

If preflight/smoke fail against real infra → gate becomes **D — FAIL**, fix
before any alpha.

## 4. Backup/restore drill (execute WHEN infra is available)

```bash
# Sealed backup — scripts/backup.sh is the ONLY supported operator path
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=<prod> NOVA_MEDIA_FS_ROOT=<root> \
  scripts/backup.sh <dest>
NOVA_BACKUP_KEY=<hex32> pnpm --filter @nova/api backup:verify -- --dir=<dest> --stamp=<stamp>
# wrong key → BACKUP VERIFY FAILED. Confirm dest holds only *.enc + manifest.
# Isolated restore into a SCRATCH db/media root:
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=<scratch> NOVA_MEDIA_FS_ROOT=<scratch-root> \
  NOVA_ENCRYPTION_KEY=<data-key> NOVA_RESTORE_CONFIRM=RESTORE scripts/restore.sh <dest> <stamp>
pnpm --filter @nova/api db:migrate      # no-op
pnpm --filter @nova/api media:verify    # every blob present + decryptable
pnpm --filter @nova/api ops:smoke -- --base-url=<scratch-api>
```

### 4b. Local production-shaped rehearsal (run THIS milestone — infra unavailable path)

Executed against the local dockerised Postgres/Redis as a stand-in. Evidence:

```
scripts/backup.sh <dest>  → wrote manifest-<stamp>.json (1 artifact, sha256 recorded)
                            dest holds ONLY: nova-db-<stamp>.dump.enc + manifest-<stamp>.json
                            (no *.dump / *.tar.gz plaintext)
backup:verify (correct key) → manifest shape:ok mac:ok
                              nova-db-<stamp>.dump.enc — hash:ok size:ok decrypt:ok → BACKUP OK
backup:verify (WRONG key)   → manifest mac:mismatch; decrypt:fail → BACKUP VERIFY FAILED
```

Restore guards + wrong-key-before-DB behaviour are covered by the CLI
integration tests (real Postgres): `m15b-backup-cli`, `m16-restore-guard`
(missing key, missing confirmation, wrong-key verify fails before `pg_restore`,
remote-target refusal, DSN redaction), `m15c-seal-guard` (in-place / symlink
rejection). **Real-infra backup/restore is PENDING** the checklist above.

## 5. Feature-gate posture at alpha start (default: DISABLED)

| Feature | Alpha-start default | Enforced by |
|---|---|---|
| Notion integration | **OFF** | not configured → preflight `notion: integration off`; adapter media-gate |
| Cloud enrichment | **OFF** | `NOVA_CLOUD_ENRICHMENT` unset (worker) |
| Live QA | **OFF** (or degraded-safe) | `NOVA_LIVE_QA` unset / no `ANTHROPIC_API_KEY` |
| Transcription | **OFF** | no `OPENAI_API_KEY` |
| Embeddings/search cloud | **OFF** (local fallback) | no `OPENAI_API_KEY` |
| External actions | **OFF / approval-only** | job queue is proposed→approved only; nothing auto-executes |
| Nova Browser | **DEFERRED** | not in scope; spike only (M12) |
| Screenshot strict redaction | **ON** | prod forces `effectiveStrict`; schema+extension default strict |
| Signup | **INVITE-ONLY** | prod refuses open signup in preflight unless `NOVA_ALPHA_INVITE_CODE` |
| Public registration | **NONE** | invite-only |
| Silent capture | **NONE** | explicit consent gate; no background capture |

Enabling any cloud/integration feature requires it to be **explicitly gated
and synthetic-smoked first**.

## 6. Logging / privacy verification

Confirmed by existing controls + tests (no code captures content into these
sinks):

- **No screenshot/base64/media content in logs** — log-hygiene test; media is
  extracted out of the payload into the encrypted pipeline; `rowToMoment`
  sanitizes legacy inline media (any case, M15C).
- **No captured content in analytics** — event props are counts/flags only
  (allowlisted server-side).
- **No captured content in feedback** — feedback is category + free-text the
  user typed; audit records category only.
- **No raw dependency errors on public endpoints** — `/readyz` booleans-only
  (M15 P3); `/v1/ops/status` maps dependency errors to `unavailable`, raw text
  to request-scoped logs only (M15-D05).
- **No raw `DATABASE_URL` in logs** — restore prints only a redacted
  `scheme://***@host/db` (M15-D03).
- **No secrets in backup artifacts** — manifest carries sha256/size/HMAC, no
  key material (M15-D04); `NOVA_BACKUP_KEY`/`NOVA_ENCRYPTION_KEY` never written
  into a backup.
- **Audit logs contain events, not sensitive content** — media audit details
  are counts/states, verified `not.toContain("data:image")`.

## 7. M15 accepted residuals — status in M16

| Residual | M16 action |
|---|---|
| **P2** `backup:seal` `--work`/`--out` symlink aliasing | **HARDENED** — distinctness now compares **physical** dirs via `realpath()` (symlinks resolved); `--dir` alias and lexical bypass rejected. `scripts/backup.sh` remains the only documented operator path. Test: `m15c-seal-guard` symlink case. |
| **P3** `applyCaptureMode` array handling | **FIXED** — the `text_only` walk now recurses into arrays and drops inline images (canonical case-insensitive detector) anywhere, incl. inside arrays. Test: `consent-capture-mode` array case. |
| **P3** restore CLI coverage | **EXPANDED** — `m16-restore-guard`: missing backup key, missing confirmation (fails closed before verify/DB), wrong-key verify fails before `pg_restore`; remote refusal + DSN redaction already in `m15b-backup-cli`. |

No residual weakens any security/privacy control.

## 8. Tests & verification run (this milestone)

- `pnpm build` + `pnpm -r typecheck` — clean (9 projects).
- Unit: `@nova/context-engine` 69 (+array case), API 49, schema 7, extension
  1, browser-shell 14.
- Integration (Postgres+Redis): full API suite + worker suite green, incl.
  new `m16-restore-guard` and updated `m15c-seal-guard`. (See PR checks.)
- Local backup rehearsal + `ops:preflight` (dev) `PREFLIGHT OK` — §4b.

## 9. Alpha gate status — STILL BLOCKED

Real alpha remains **blocked**. It may start ONLY after ALL of:

- [ ] controlled deploy succeeds (real infra);
- [ ] `ops:preflight` succeeds against real infra (mode=production);
- [ ] `ops:smoke` succeeds against real infra (synthetic only);
- [ ] OCR/redaction verified on synthetic screenshots;
- [ ] Redis/worker/media storage verified;
- [ ] sealed backup created (`scripts/backup.sh`);
- [ ] `backup:verify` passes (and wrong-key fails);
- [ ] isolated restore drill passes;
- [ ] `media:verify` passes post-restore;
- [ ] post-restore `ops:smoke` passes;
- [ ] **operator explicitly approves real alpha.**

Until then: no real user data, no real users, no silent capture.

## 10. Gate decision & next step

**Decision: C — DEPLOY-GATE BLOCKED.** Deploy-ready, not deployed; no P0/P1;
M15 residuals hardened. When the operator supplies the §2 credentials, execute
§3 + §4; a clean run flips this to **A (DEPLOY-GATE PASS)** — or **B
(CONDITIONAL)** if only minor P2/P3 remain — at which point a short Hermes
delta re-audit of the real-infra deploy is recommended before one-user alpha.

**Exact next step:** operator provisions blockers #1–#13 (§2) into the secret
store, then runs §3 (deploy + preflight + synthetic smoke) and §4 (backup +
restore drill), and records results back into §9.
