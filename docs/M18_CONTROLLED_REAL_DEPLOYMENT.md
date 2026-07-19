# M18 — Controlled Real Infrastructure & Synthetic Deployment (PLAN SKELETON)

> **Status: NOT EXECUTED.** This document is the evidence skeleton for M18
> Phase B2–B10. It is filled in ONLY as real, authorized steps actually run.
> Every section below is intentionally empty or marked pending — nothing here
> may be pre-filled with imagined results. Prerequisite: the operator's
> explicit `APPROVE M18 PROVISIONING` phrase (see
> `M18_PREPROVISION_READINESS.md` §8 for the proposed plan).

## 0. Authorization received

- Phrase: _pending_
- Provider plan / region / budget cap / temporary-recovery approval: _pending_

## 1. Resources created (B2)

_pending — table of resource / sanitized identifier / region / plan /
created-at / expected cost / connectivity / TLS / private-network / retention
/ teardown status. No credentials, no sensitive connection strings._

## 2. Predeploy gate (B3)

_pending — the Render pre-deploy command `pnpm validate:deploy` (config-safety
→ prerequisites → db:migrate once → ops:preflight → db:migrate:status):
outcome (PASS/CONDITIONAL_PASS required), report run-id + hashes, evidence-store
prefix._

## 3. Controlled deployment (B4)

_pending — API/worker boot, migrations, /healthz, /readyz, worker heartbeat,
queue + media-store connectivity, HTTPS, no-leak verification. Synthetic
data only; no browser-shell/extension/public distribution._

## 4. Postdeploy gate (B5)

_pending — outcome, synthetic-session lifecycle proof (bootstrap → authed
status → smoke → cleanup), report run-id + hashes._

## 5. Backup + isolated recovery drill (B6)

_pending — driven by the SINGLE orchestration entrypoint
`pnpm validate:recovery-remote -- --stamp=<s> --restored-base-url=<url>
[--invite=<code>]` (never a hand-composed fetch+mkdir+gate+rm chain). It: seals
a DB backup + `backup:publish-s3` off-box (remote commit marker), `media:backup-s3`
inventory, wrong-key proof; creates a NEW private 0700 workspace; `backup:fetch-s3`
into it (marker auth + per-artifact verify + local `backup:verify` BEFORE
restore); runs `restore.sh` in `NOVA_RESTORE_MODE=authorized-scratch` (the SAME
`backup:scratch-guard` decision the gate validated — production override
inaccessible, re-checked immediately before `pg_restore`, unseal via
`backup:unseal-file`); restores S3 media into the scratch bucket and runs
`media:verify` in the CORRECTED order (DB → media restore → media:verify, never
media:verify first); post-restore smoke against the restored stack; ALWAYS
removes the temporary workspace and reports any cleanup failure; teardown
evidence for the temporary recovery resources._

## 6. Cost & operational baseline (B7)

_pending — actual plan costs, storage/egress, durations (deploy, predeploy,
postdeploy, backup, restore, smoke), media bytes, request counts. Observed /
synthetic / non-production — not product SLAs._

## 7. Security & privacy evidence (B8)

_pending — log/secret sweeps, ciphertext-at-rest, no public object URLs,
isolation, deletion, keys-absent-from-backups, optional features off, no
real user data. Not a substitute for the later runtime pentest._

## 8. Failures, fixes, remaining blockers

_pending_

## 9. Hermes runtime audit (B10)

_pending — read-only, evidence-based; no merge/provision/infra-change/raw-
secret access._

## 10. Real-alpha gate decision

_pending — real alpha remains NOT APPROVED / BLOCKED until the audit result
and explicit operator approval._
