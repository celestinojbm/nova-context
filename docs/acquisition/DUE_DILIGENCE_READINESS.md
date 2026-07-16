# Due-Diligence Readiness — living report (baseline `74ac864c`, 2026-07-16)

High-level, buyer-facing readiness view. Updated per the Value Delta policy.
This is **not** a data room and contains no private records.

## 1. Executive status
Technology asset at private-alpha readiness: strong verified engineering
evidence in-repo; ownership, deployment, and market evidence pending.
Score 59/100 (medium confidence; not a valuation). Real alpha BLOCKED.

## 2. Technical state
Typed pnpm/Turborepo monorepo (10 workspaces): Fastify API, BullMQ worker,
Next.js web, WXT extension, Electron spike, shared Zod contracts. M0–M17B
merged with per-milestone PR trail; CI green on main; Validation Gate v0
orchestrates the full check sequence with honest go/no-go semantics.

## 3. Product state
Complete synthetic-data loop: consented capture → capture-time + visual
redaction → encrypted media pipeline → memory/search → reviewed external
actions (Notion) → export/delete lifecycle. No real users yet (by design —
hard gate).

## 4. Security/privacy state
Three external Hermes audits (M15→M15C) ending CONDITIONAL PASS; documented
accepted P2 residual with operator rule. Fail-closed production posture
(invite-only, strict redaction, encryption at rest, sealed backups, DSN
redaction, sanitized ops endpoints, cross-user isolation suites,
prompt-injection tests, log-hygiene tests). No runtime pentest yet
(no runtime exists).

## 5. Infrastructure/operations state
Deploy-ready, not deployed: Fly configs + Dockerfiles, operator packet,
`.env.production.template`, preflight/smoke/report commands, sealed
backup/restore with local drills, operator gates (`validate:predeploy/
postdeploy/recovery`) that honestly BLOCK without real credentials. No cost
baseline, no performance baselines (Harness v1 deferred).

## 6. IP state
**Not verified.** No LICENSE file; AI-assisted authorship recorded in git
trailers without a provenance statement; owner entity undocumented; no
assignments evidenced. This is the primary diligence blocker (R-01).

## 7. Dependency/license state
Prod tree enumerated (212 pkgs, permissive-dominant; 1 transitive LGPL
prebuilt, 1 CC-BY data file; no GPL/AGPL). NOTICE file absent. Dev-tree
transitive review pending. Professional review flagged.

## 8. Commercial-evidence state
None (no users, revenue, waitlist, LOIs). Business-model thesis documented
only. Entity/financial records out of repo scope and unverified.

## 9. Technical debt
Documented and bounded: accepted P2 backup:seal symlink residual
(operator-rule mitigated), per-instance rate-limit fallback, s3-backup
reliance on bucket controls, Harness v1 deferred, browser-shell is a spike.

## 10. Risks
Critical: R-01 (chain of title). High: R-02 (no real deployment), R-03
(founder dependency), R-04 (no market evidence). Medium: R-05–R-09. Low:
R-10–R-12. See `RISK_REGISTER.md`.

## 11. Essential dependencies
Postgres+pgvector, Redis/BullMQ, Fastify/Next/React/WXT, tesseract.js+jimp,
S3-compatible storage, optional Anthropic/OpenAI/Notion providers (OFF by
default).

## 12. Known limitations
Solo-operated; synthetic-only validation; no scale/perf characterization;
single-region assumptions; English-first OCR/redaction.

## 13. Available evidence
See `EVIDENCE_INDEX.md` (EV-01…EV-16): code, tests, audits, gates, docs,
runbooks, PR history — all at the baseline SHA.

## 14. Missing evidence
Ownership/assignments; real-deploy gate reports; cost/perf baselines;
demand artifacts; entity/financial records; provider-account inventory;
privacy policy/ToS.

## 15. Questions a likely buyer would ask
Who owns the code (incl. AI-assisted portions)? Can accounts/domains/keys
transfer cleanly? What does it cost to run? What breaks at 10× load? Why do
users want this (evidence)? What happens if the single operator leaves?
What are the provider-terms constraints on the model features? What is the
privacy/regulatory posture with real user data?

## 16. Actions required before opening a data room
Chain-of-title verification + license posture; one real controlled
deployment with all three operator gates passing; account/domain
consolidation under the owning entity; initial demand evidence; drafted
privacy policy/ToS; engaged legal/accounting review.

## 17. Items requiring professional review
IP assignment & license posture (legal); LGPL prebuilt, Redis server terms,
provider ToS at transfer (legal); entity/tax/insurance (accounting); runtime
pentest & privacy compliance before real users (security/legal).
