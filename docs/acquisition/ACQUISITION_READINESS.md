# Acquisition Readiness — Baseline v0 (M17C)

- **Baseline commit:** `74ac864c9122c982a0a4b4e178c243df14b8b978` (main, M0–M17B)
- **Baseline date:** 2026-07-16
- **Score:** 59/100 (see `ACQUISITION_SCORE.json`; **not a market valuation**)
- **Overall confidence:** medium

## 1. Executive summary

Nova Context is a privacy-first "context capture → memory → action" platform
(browser extension + API + worker + web app) at private-alpha readiness,
**not yet deployed to real infrastructure and with no real users**. Its
strongest transferable assets are verified in-repo: a coherent typed
monorepo (M0–M17B), an unusually deep test/validation posture (unit +
Postgres/Redis integration suites incl. isolation/adversarial/redaction/
lifecycle, three external Hermes security audits ending in a conditional
pass, and a Validation Gate with honest go/no-go semantics), sealed
encrypted backup/restore with drills, and extensive operator documentation.
Its weakest dimensions are exactly the off-repository ones: **IP chain of
title is not independently verified** — as of M17D personal ownership by the
founder is `operator_attested` (intended owner, sole human contributor, AI
provenance disclosed; see `CHAIN_OF_TITLE_STATUS.md`) but the documentary
package and professional review do not exist yet — the **repository license
posture is undecided** (a separate question from ownership — no LICENSE or
proprietary-use statement exists), there is **no real deployment or cost
evidence**, and there is **no market/demand evidence**. The score is capped
accordingly.

## 2. Current verified state

Repository at the baseline commit builds, typechecks, and passes
`pnpm validate:pr` (gate outcome PASS) in CI on every mainline merge.
Milestones M0–M17B merged via PR history (#1–#14 pattern). Real alpha is
explicitly BLOCKED pending operator infrastructure, real deploy gates, and
explicit approval.

## 3. Verified complete (in-repo evidence)

- Monorepo build/typecheck across 10 workspaces; CI green on main.
- Test suites: API unit 49, context-engine 69, schema 7, extension 1,
  browser-shell 14, validation-gate 56; integration API 215+/worker 30+
  (auth, cross-user isolation, security/prompt-injection, visual redaction,
  media safety, export/delete lifecycle, backup/restore guards).
- Security remediation trail: Hermes audits (M15 → M15B → M15C) ending
  **CONDITIONAL PASS**; the one P2 residual accepted at that audit
  (backup:seal symlink aliasing) was subsequently **fully hardened in M16**
  (`realpath()` physical-directory comparison + regression tests) and is
  closed unless new evidence reopens it.
- Encrypted-at-rest media/tokens (AES-256-GCM, key rotation), sealed
  HMAC-authenticated backups, guarded restore, local drills.
- Validation Gate v0 (+ M17B.1 hardening) with sanitized reports.
- Operator documentation: 28+ docs incl. deployment packet, runbooks,
  security/privacy governance, alpha guide, HANDOFF continuity.

## 4. Verified partial

- Infrastructure/operations: deploy-ready (Fly configs, preflight/smoke,
  `.env.production.template`) but **never executed against real infra**.
- Product: full synthetic-data product loop works; no real usage.
- Dependency/license inventory: prod tree enumerated (212 pkgs); full
  transitive review incomplete (see inventory doc).

## 5. Absent

- Repository **LICENSE file / proprietary-use statement** (unlicensed =
  default all-rights-reserved, but the unstated posture is a diligence
  question in its own right — R-13). Its absence is **not** evidence about
  ownership, and no license should be adopted before the owner and intended
  posture are determined.
- Real deployment, real backups/restore on real infra, cost baseline,
  performance baselines.
- Market/demand evidence (users, waitlist, LOIs, revenue).
- NOTICE/attribution file for CC-BY data and bundled components.

## 6. Not independently verified (off-repository)

- Legal ownership of Nova Context — intended personal ownership by the
  founder is now `operator_attested` (M17D, EV-17; Stravos Enterprises LLC
  is not the intended owner and no Stravos ownership is claimed), but this
  remains **not independently verified**; do not treat attestation as
  documentary evidence.
- Authorship/ownership statement, entity records (context), domain/trademark
  (none exist yet), provider/billing account ownership proof (attested,
  unproven), privacy-policy obligations.

## 7. Not applicable / 8. Premature (current stage)

- Not applicable: customer contracts, revenue recognition, SOC2-type
  attestations (no customers, no production).
- Premature: full data room; calibrated performance SLAs (Harness v1);
  multi-region/scale posture; security certification.

## 9. Top five acquisition risks (see RISK_REGISTER.md)

1. **R-01 — personal ownership operator-attested, documentary chain of
   title incomplete** (M17D): the attestation lowers the estimated
   probability of a competing claim but the diligence evidence package does
   not exist, which alone can block an acquisition — still P0, still open.
   Repository license posture is tracked separately (R-13).
2. **R-02 No real deployment evidence** — operational claims unproven off
   local rehearsals; blocks any operational representations.
3. **R-03 Founder/single-operator dependency** — one human operator; bus
   factor 1 for accounts, keys, decisions.
4. **R-04 No market evidence** — value rests on technology alone today.
5. **R-05 Provider transferability** (Anthropic/OpenAI/Notion/Fly terms &
   accounts) — conditional blocker for asset transfer.

## 10. Five highest-impact / lowest-effort actions

1. Verify chain of title: owner decision + signed IP assignment (legal
   review). A LICENSE file is NOT part of this — it would not prove
   ownership.
2. After the owner is determined: decide and record the repository licensing
   posture (undecided today; no posture is assumed here) with legal review,
   plus an AI-assisted development provenance statement + NOTICE file.
3. Execute the M17 real-deploy gates once credentials exist
   (`validate:predeploy/postdeploy/recovery` on real infra) — converts the
   largest "partial" to "verified".
4. Consolidate account/domain ownership under the owning entity with
   documented recovery (reduces R-03/R-05).
5. Start minimal demand evidence (alpha waitlist / 2–3 signed LOIs).

## 11. Single next recommended action

**Private documentary/professional verification of the personal chain of
title** (action 1; attestation recorded in M17D, closure criteria in
`CHAIN_OF_TITLE_STATUS.md` §15). Everything else is capped by it (score cap
≤70; acquisition blocker).

## 12. Current stage limitations

Solo-operated, pre-deployment, pre-users, AI-assisted development, no
entity/ownership evidence in scope of this audit. Scores in product,
infrastructure, IP, and business dimensions are structurally limited until
those change; documentation cannot substitute.

## 13. What must change before a real data room is justified

Verified chain of title; at least one real controlled deployment with the
three operator gates passing; a named owning entity with consolidated
accounts; initial demand evidence; professional legal/accounting review
engaged. Until then a data room would formalize unverified claims.
