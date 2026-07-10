# M15 — Alpha Blocker Remediation (Hermes audit response)

External adversarial audit by **Hermes** reviewed Nova Context at baseline
commit **`49b6525`** and returned **NO-GO** for private alpha until the P1
findings are fixed and real deployment checks are verified.

Every finding below was treated as valid. Each was reproduced against the
baseline code, fixed, and covered by a regression test. Nothing here argues
the auditor was wrong.

Status after M15: **all P1/P2/P3 findings remediated with tests; CI green.**
A Hermes delta audit is recommended before the alpha starts, and the M14
hard gate stands — **no real user data until explicit operator approval.**

---

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
