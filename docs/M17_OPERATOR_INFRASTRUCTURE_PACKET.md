# M17 — Operator Infrastructure Packet (M17A)

**This is the bridge between M16 (DEPLOY-GATE BLOCKED) and M17 (real deploy
execution).** It is the exact packet an operator completes to provision Nova
Context infrastructure safely.

**M17A did NOT deploy, provision, or create any resource, and performed no
external writes. No secrets were generated or stored.** Nothing here runs on
its own — every step is for a human operator to execute later, only when
authorized.

- **Scope:** documentation + placeholder template only.
- **Companion files:** `.env.production.template` (placeholders), the
  authoritative per-variable docs `services/{api,worker}/.env.example`,
  provider commands in `infra/DEPLOY.md`, the deploy gate + runbook in
  `docs/M16_CONTROLLED_DEPLOYMENT_GATE.md`, and `docs/RUNBOOKS.md`.

> **Golden rules**
> - **Never commit** a filled-in env file. `.env.production` and
>   `.env.*.local` are gitignored; only `.env.production.template`
>   (placeholders) is tracked.
> - **Never print** a real secret into a doc, PR, issue, terminal transcript,
>   or log. Keys live ONLY in your provider secret manager.
> - **Never weaken** a security/privacy control to make a deploy easier
>   (redaction, invite-only, sealed backups, media gates stay ON).
> - **Never fake** a deploy. If a credential is missing, stay BLOCKED.

---

## 1. Infrastructure checklist

Provider-neutral requirement → what to provision. `infra/DEPLOY.md` has the
Fly.io-specific commands; substitute your provider where noted.

| # | Requirement | Exact requirement | Supplied by |
|---|---|---|---|
| 1 | Hosting provider auth | CLI authenticated for 3 services (api/worker/web). Fly: `fly auth login` + `infra/deploy/fly.*.toml` | Operator |
| 2 | Production domain | e.g. `api.<domain>`, `app.<domain>`; DNS records to the provider | Operator |
| 3 | HTTPS/TLS | Managed certs for both domains (Fly: `fly certs add`) | Operator/provider |
| 4 | Managed Postgres 16 **+ pgvector** | Connection string → `DATABASE_URL`; `CREATE EXTENSION vector` permitted (migration runs it) | Provider (Fly PG / Neon / Supabase) |
| 5 | Redis | Plain connection string → `REDIS_URL` (BullMQ) | Provider (Fly / Upstash) |
| 6 | Media object storage | Private, **versioned**, **SSE-encrypted** S3-compatible bucket → `NOVA_MEDIA_S3_*`. Prefer s3 in prod (fs needs a persistent volume) | Operator |
| 7 | Data encryption key | `NOVA_ENCRYPTION_KEY` = 32-byte hex (see §3). Required in prod; API+worker must match | Operator (generate) |
| 8 | Backup seal key | `NOVA_BACKUP_KEY` = 32-byte hex, **SEPARATE** from #7, never stored with backups | Operator (generate) |
| 9 | Invite code | `NOVA_ALPHA_INVITE_CODE` (prod signup is invite-only) | Operator (generate) |
| 10 | Backup destination | Access-controlled store **separate** from app hosts (private, versioned bucket) | Operator |
| 11 | Backup retention | ≥14 daily; prune whole `<stamp>` sets (`.enc` + manifest) — RUNBOOKS §Backup policy | Operator policy |
| 12 | Worker deployment | Same `DATABASE_URL`/`REDIS_URL`/keys/media as API; `fly deploy -c infra/deploy/fly.worker.toml` | Operator |
| 13 | Per-service env vars | `.env.production.template` + `services/{api,worker}/.env.example` | Operator |
| 14 | Disabled-at-start flags | §5 posture (Notion/cloud/live-QA/transcription OFF; strict ON; invite-only) | Operator (defaults in template) |
| 15 | Rollback plan | §Rollback below | Operator |

## 2. Environment variable checklist

Full grouped list with placeholders is in **`.env.production.template`**.
Grouped summary:

- **app/runtime:** `NODE_ENV=production`, `PORT`, `NOVA_GIT_SHA`
- **database:** `DATABASE_URL` (Postgres+pgvector)
- **redis:** `REDIS_URL`
- **media storage:** `NOVA_MEDIA_STORE=s3`, `NOVA_MEDIA_S3_{BUCKET,REGION,ENDPOINT,ACCESS_KEY_ID,SECRET_ACCESS_KEY}` (or `NOVA_MEDIA_FS_ROOT` if fs)
- **encryption:** `NOVA_ENCRYPTION_KEY` (+ `NOVA_ENCRYPTION_KEYS_PREVIOUS` only during rotation)
- **backup:** `NOVA_BACKUP_KEY` (separate)
- **auth/session:** `NOVA_SESSION_TTL_HOURS`, `NOVA_EXTENSION_SESSION_TTL_HOURS`
- **invite/signup:** `NOVA_SIGNUP=invite`, `NOVA_ALPHA_INVITE_CODE`
- **feature gates (OFF):** `NOTION_*` blank, `NOVA_CLOUD_ENRICHMENT=off`, `NOVA_LIVE_QA=off`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` blank
- **redaction (ON):** `NOVA_REDACTION=on`, `NOVA_IMAGE_REDACTION=on`, `NOVA_SCREENSHOT_STORAGE=on`, `NOVA_ALLOW_UNSAFE_REDACTION=` (blank)
- **logging/analytics:** `NOVA_ANALYTICS=local`
- **ops:** `NOVA_RATE_LIMIT_MAX`, `NOVA_REQUEST_TIMEOUT_MS`, `NOVA_MEDIA_WARN_MB`
- **web:** `NOVA_API_URL`
- **worker:** the shared subset above + `NOVA_ACTION_QUEUE`

## 3. Secret generation guide

Generate on a trusted machine; paste the OUTPUT into your secret manager only.
**Placeholders shown — never store the real output in the repo or a doc.**

```bash
# Data-at-rest key (media blobs + integration tokens). API AND worker share it.
openssl rand -hex 32     # -> NOVA_ENCRYPTION_KEY

# Backup seal key — MUST be different from NOVA_ENCRYPTION_KEY.
openssl rand -hex 32     # -> NOVA_BACKUP_KEY

# Alpha invite code (min 8 chars).
openssl rand -hex 12     # -> NOVA_ALPHA_INVITE_CODE
```

- **Session/auth secrets:** none to generate — sessions are opaque
  server-side tokens minted from CSPRNG at runtime (M5); there is no separate
  signing secret to provision.
- **Storage:** provider secret manager only (`fly secrets set ...`), never on
  disk in the repo, never in a chat/PR/log.
- **Rotation:** `NOVA_ENCRYPTION_KEY` rotates zero-downtime via
  `NOVA_ENCRYPTION_KEYS_PREVIOUS` + `media:rotate-key` (RUNBOOKS §Rotate).
  Rotate `NOVA_BACKUP_KEY` by taking a fresh sealed backup with the new key.
  Rotate the invite code any time (revokes future signups on the old code).
- **Recovery limitation (READ THIS):** keys are NOT recoverable. Lose
  `NOVA_ENCRYPTION_KEY` → media blobs + integration tokens are permanently
  unreadable (a restore yields metadata only). Lose `NOVA_BACKUP_KEY` →
  sealed backups are permanently unrecoverable. Store both in a durable,
  access-controlled secret manager with its own backup.

## 4. `.env.production.template`

Created at repo root: **`.env.production.template`** — placeholders only,
grouped exactly as §2, with the safe posture (§5) pre-set. Copy it per
service, fill it in **in your secret manager**, and never commit the result.

## 5. Feature-gate posture (first real deploy)

| Feature | First-deploy default | How enforced |
|---|---|---|
| Notion | **OFF** | `NOTION_*` blank → integration off; adapter media-gate |
| Cloud enrichment | **OFF** | `NOVA_CLOUD_ENRICHMENT=off` (worker) |
| Live QA | **OFF** (degrade-safe) | `NOVA_LIVE_QA=off` / no `ANTHROPIC_API_KEY` → 503 |
| Transcription | **OFF** | no `OPENAI_API_KEY` → 503 (typed input still works) |
| Embeddings (cloud) | **OFF** (keyword fallback) | no `OPENAI_API_KEY` |
| Nova Browser | **DEFERRED** | not in scope (M12 spike only) |
| External actions | **approval-only** | proposed→approved queue; nothing auto-executes |
| Screenshot strict redaction | **ON** | prod forces strict; schema+extension default strict |
| Signup | **INVITE-ONLY** | `NOVA_SIGNUP=invite` + code; prod fails closed otherwise |
| Public registration | **NONE** | invite-only |
| Silent capture | **NONE** | explicit consent gate; no background capture |

Enabling any cloud/integration feature later requires it to be explicitly
gated and **synthetic-smoked first**.

## 6. Pre-deploy operator checklist

Complete every row (in your secret manager / provider console) **before**
authorizing M17 deploy execution.

| Item | Required value | Where to set | How to verify | Risk if missing |
|---|---|---|---|---|
| Provider auth | logged-in CLI | local shell | `fly auth whoami` | cannot deploy |
| Domain + DNS | `api.*`, `app.*` | provider DNS | `dig`/provider console | no reachable endpoint |
| TLS certs | issued | provider | `fly certs show` / HTTPS 200 | insecure/blocked |
| `DATABASE_URL` | Postgres+pgvector DSN | api+worker secrets | preflight `postgres` + `migrations` ✓ | no persistence / boot fail |
| `REDIS_URL` | Redis DSN | api+worker secrets | preflight `redis` ✓ | no enrichment/queue; degraded limiter |
| `NOVA_MEDIA_S3_*` | bucket + keys | api+worker secrets | preflight `media_store` ✓; smoke media step | media cannot store |
| `NOVA_ENCRYPTION_KEY` | 32-byte hex | api+worker secrets (identical) | preflight `encryption_key` ✓ | prod refuses to boot |
| `NOVA_BACKUP_KEY` | 32-byte hex (≠ above) | secret manager (not with backups) | `backup:verify` after first backup | no backups possible |
| `NOVA_SIGNUP=invite` + `NOVA_ALPHA_INVITE_CODE` | invite + code | api secrets | preflight `signup_policy` = invite | open signup / no signup |
| Redaction flags ON | `on` / blank unsafe flag | api secrets | preflight `redaction`, `screenshot_storage` ✓ | unsafe media |
| Cloud/integration OFF | blank keys / `off` | api+worker secrets | preflight `notion`/`cloud_features` = off | unintended data egress |
| Backup destination + retention | private versioned store; ≥14d | operator policy | first backup lands there | data loss |
| Rollback ready | prev release id noted | provider | `fly releases` | slow incident recovery |

**Gate:** all rows ✓ **and** `ops:preflight` prints `PREFLIGHT OK`
(mode=production) before any deploy proceeds to smoke.

## 7. Validation commands (run against real infra when it exists)

> **M17B:** these steps are also orchestrated by the Validation Gate
> (`docs/VALIDATION_GATE.md`) with go/no-go reports:
> `pnpm validate:predeploy` (posture + preflight),
> `pnpm validate:postdeploy -- --base-url=… [--invite=…]` (readyz + synthetic
> smoke), `pnpm validate:recovery -- --backup-dir=… --stamp=…`
> (verify + wrong-key + guarded scratch restore + media:verify). Each mode
> returns `BLOCKED` (never a fake pass) until its prerequisites exist.

```bash
# Preflight (must print PREFLIGHT OK, mode=production)
fly ssh console -c infra/deploy/fly.api.toml -C "node dist/db/run-preflight.js"
# Readiness (booleans only; must be ready:true)
curl -fsS https://<api-domain>/readyz
# Authenticated status (operator session; degraded flags only, no raw errors)
#   GET https://<api-domain>/v1/ops/status
# Synthetic smoke (self-deleting synthetic account — NO real user data)
fly ssh console -c infra/deploy/fly.api.toml -C \
  "node dist/db/run-smoke.js --base-url=https://<api-domain> --invite=<code>"
# Sealed backup + verify (scripts/backup.sh is the ONLY operator path)
NOVA_BACKUP_KEY=<hex32> DATABASE_URL=<prod> NOVA_MEDIA_FS_ROOT=<root> scripts/backup.sh <dest>
NOVA_BACKUP_KEY=<hex32> pnpm --filter @nova/api backup:verify -- --dir=<dest> --stamp=<stamp>
# Isolated restore drill (SCRATCH db/media) → migrate no-op → media:verify → smoke
```

## 8. Rollback checklist

- **App:** redeploy the previous image — `fly releases` → `fly deploy --image <prev>`
  (per service; API first). Web/worker are stateless.
- **Database:** migrations are **forward-only** (`schema_migrations`). Do NOT
  hand-edit. To recover data, restore the latest sealed backup into a
  **scratch** target and promote deliberately (RUNBOOKS §Restore); never
  `restore.sh` straight over production without `NOVA_RESTORE_ALLOW_PRODUCTION=yes`
  and the typed confirm.
- **Keys:** never "roll back" a key by deleting it — see §3 recovery limits.
- **Kill switch:** set `NOVA_SCREENSHOT_STORAGE=off` to stop storing any new
  media immediately; `NOVA_SIGNUP=closed` to halt new signups.

## 9. Cost-risk warnings

- Managed Postgres, Redis, object storage, egress, and always-on app machines
  **incur real, recurring cost.** Provision the smallest tier for a
  handful of alpha users; set billing alerts.
- Object storage **versioning + retention** multiplies stored bytes — prune
  per §Backup policy.
- Cloud model keys (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) bill per token and
  **send captured content off-box** — they stay **OFF** at first deploy.
- Nothing in M17A spends money. Provisioning happens only when the operator
  runs the provider commands with real credentials.

## 10. What the operator must supply / never do

**Must supply:** items #1–#13 in §1 (auth, domain, TLS, Postgres+pgvector,
Redis, media bucket, the three generated keys/codes, backup destination +
retention policy, worker deploy, per-service env).

**Must never commit:** any filled-in `.env.production`, real
`DATABASE_URL`/`REDIS_URL`, S3 keys, `NOVA_ENCRYPTION_KEY`, `NOVA_BACKUP_KEY`,
`NOVA_ALPHA_INVITE_CODE`, model API keys.

**Must never print in logs:** raw `DATABASE_URL` (restore redacts it), secrets,
captured screen content/base64/media, integration tokens. (Enforced: `/readyz`
booleans-only, `/v1/ops/status` sanitized, log-hygiene test, DSN redaction.)

**Must verify before any deploy:** the §6 checklist all ✓ and
`ops:preflight` = `PREFLIGHT OK` (mode=production).

## 11. Deployment execution handoff (→ M17)

- **If ALL §1 credentials are available:** proceed to **M17 — controlled
  deployment execution** (M16 report §3–§4): deploy api/worker/web → migrate →
  `ops:preflight` (prod) → `/readyz` + authed `/v1/ops/status` → `ops:smoke`
  with **synthetic content only** → verify OCR/redaction/media/worker/
  export-delete → logs+analytics carry no content → sealed `scripts/backup.sh`
  → `backup:verify` (wrong key fails) → isolated restore drill → `media:verify`
  → post-restore smoke. A clean run ⇒ **DEPLOY-GATE PASS** (or CONDITIONAL);
  then a Hermes delta re-audit is recommended **before** one-user alpha.
- **If ANY credential is missing:** remain **BLOCKED**. Do not deploy, do not
  fake a deploy, do not provision paid resources without authorization.
- **Always:** synthetic smoke only; sealed backup + restore drill before any
  alpha; **no real user data, no real users, no silent capture** until the
  operator explicitly approves real alpha.

## 12. M17A status

**No deploy. No provisioning. No external writes. No secrets generated or
stored.** The packet is ready for the operator to complete §6, after which
M17 (real deploy execution) may run — gated on those credentials and explicit
approval. Real alpha remains **BLOCKED**.
