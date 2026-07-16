# Evidence Index — baseline `74ac864c` (2026-07-16)

Maps acquisition dimensions to EXISTING repository evidence. References,
never duplicates. Freshness = as of the baseline commit; confidence reflects
how directly the artifact proves the claim. No private URLs or local paths.

| ID | Category | Location (repo path / PR) | Proves | Does NOT prove | Freshness | Confidence | Owner |
|---|---|---|---|---|---|---|---|
| EV-01 | product | `docs/PRODUCT_VISION.md`, `docs/MVP_SCOPE.md`, `docs/THE_CONTEXT_MANIFESTO.md` | articulated differentiation + scoped MVP | demand, users, willingness to pay | baseline | high (as docs) | operator |
| EV-02 | product | `apps/extension/`, `apps/web/`, `services/api/`, `services/worker/` (M0–M14 PR history) | working end-to-end synthetic product loop | real-world usage or retention | baseline | high | operator |
| EV-03 | architecture | `docs/SYSTEM_ARCHITECTURE.md`, `docs/CONTEXT_ENGINE.md`, `docs/API_AND_SDK_SPEC.md`, `docs/REPO_STRUCTURE.md` | documented architecture matching the code layout | scalability under load | baseline | high | operator |
| EV-04 | architecture | `pnpm-workspace.yaml`, `turbo.json`, `packages/*`, typed Zod contracts in `packages/schema` | coherent typed monorepo, single source of truth for contracts | — | baseline | high | operator |
| EV-05 | testing | workspace test suites (`services/api/test/integration/*`, `services/worker/test/integration/*`, unit suites per package) | auth, cross-user isolation, security/prompt-injection, visual redaction, media safety, export/delete, backup/restore guard coverage | real-infra behavior, performance | baseline | high | operator |
| EV-06 | security | `docs/AUDIT_RESPONSE_M15.md` (3 Hermes audits → conditional pass), `docs/M16_CONTROLLED_DEPLOYMENT_GATE.md` (residual hardening), `docs/SECURITY_PRIVACY_GOVERNANCE.md`, `docs/RISKS_AND_RED_TEAM.md` | external adversarial review + remediation trail; the P2 residual accepted at the audit (backup:seal symlink aliasing) was fully hardened in M16 (realpath + regression tests) and is closed | pentest of a running deployment | baseline | high | operator |
| EV-07 | validation | `docs/VALIDATION_GATE.md`, `tools/validation-gate/`, `.github/workflows/ci.yml` (gate runs in CI); latest PR-mode result: **PASS** on `0d7c5c2`/CI on `74ac864` | central go/no-go orchestration; PR gate green; predeploy/postdeploy/recovery honestly BLOCKED | production readiness, demand, IP, transferability, value | baseline | high | operator |
| EV-08 | security | `packages/context-engine/src/secret-box.ts`, `services/api/src/backup/*` (AES-256-GCM, HMAC manifests), `scripts/backup.sh`, `scripts/restore.sh` | encryption at rest, sealed authenticated backups, guarded restore | real-infra drill (local rehearsals only) | baseline | high | operator |
| EV-09 | privacy | redaction stack (`packages/context-engine/src/redaction.ts`, `visual-redaction.ts`, `data-url.ts`), log-hygiene + sanitizer tests | capture-time + visual redaction, fail-closed media, no-content logging | regulatory compliance (needs professional review) | baseline | high | operator |
| EV-10 | operations | `infra/DEPLOY.md`, `infra/deploy/*` (Fly configs + Dockerfiles), `docs/M17_OPERATOR_INFRASTRUCTURE_PACKET.md`, `.env.production.template` | deploy-ready path + operator packet | an actual deployment | baseline | medium | operator |
| EV-11 | operations | `docs/RUNBOOKS.md` (14+ runbooks), `docs/M16_CONTROLLED_DEPLOYMENT_GATE.md`, `docs/ALPHA_RUN.md`, ops commands (`ops:preflight/smoke/report`, `media:verify`) | operational procedures + rehearsal evidence (M14/M16 local) | real ops history, cost baseline | baseline | medium | operator |
| EV-12 | transferability | `HANDOFF.md` (full milestone table M0–M17B), `README.md`, 28+ docs | a new engineer can reconstruct state and rationale | that a transfer was actually rehearsed | baseline | high | operator |
| EV-13 | transferability | git history + PR trail (#1–#14 pattern, milestone-per-PR) | traceable provenance of every change | legal ownership of those changes | baseline | high | operator |
| EV-14 | ip | `git shortlog -sne`: two recorded identities (operator account + AI-assistant co-authorship trailers) | the authorship record *as recorded in git* — a provenance signal only | chain of title or assignments; whether the identities represent distinct legal contributors (requires operator confirmation: same person via multiple accounts / AI co-author / third party / unknown); license posture (separate question — NO LICENSE file exists, R-13) | baseline | low | operator + legal |
| EV-15 | dependencies | `pnpm-lock.yaml`, `DEPENDENCY_AND_LICENSE_INVENTORY.md` (212 prod pkgs; 1 transitive LGPL, 1 CC-BY data) | permissive-dominant dependency posture | full transitive legal review | baseline | medium | operator |
| EV-16 | business | `docs/BUSINESS_MODEL.md`, `docs/WHY_NOW.md` | articulated model/thesis | entity, ownership, financials, market traction | baseline | low (docs only) | operator |

**Freshness rule:** entries are point-in-time at the baseline SHA. A future
Value Delta must re-stamp any entry it relies on.
