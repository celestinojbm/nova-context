# Acquisition readiness (M17C)

**Purpose.** Nova Context carries a permanent strategic objective: build and
operate Nova so it can progressively become a **transferable, acquirable
technology asset** — product, source, infrastructure, documentation,
operational knowledge, accounts/services, and associated IP. This folder is
the evidence-based baseline and the lightweight standing process for that
objective. It is an audit/documentation lens, **not** a separate roadmap: it
never stops product work, and it is not a decision to sell anything.

## What belongs here (repository)

Technical evidence index, readiness assessment, machine-readable score,
risk register, transferability checklist, public dependency/license
inventory, the Value Delta policy, and the due-diligence readiness report.
Everything here must be shareable with a future reviewer as-is.

## What must remain in PRIVATE storage (never committed)

Signed IP assignments; corporate/formation records; contracts and contributor
agreements; financial and tax records; identity documents; account-ownership
proof; customer data; legal opinions; credentials and recovery codes. See
`IP_AND_TRANSFERABILITY_CHECKLIST.md` for the private-evidence checklist
(names and status only — never the documents themselves).

## Hard rules

- **No secrets** — no keys, tokens, DSNs, invite codes, private URLs, or
  private file paths in any file in this folder.
- **No legal conclusions** — license notes and ownership statuses here are
  engineering observations; anything marked *professional review required*
  needs a lawyer/accountant/security professional before reliance.
- **The Acquisition Score is not a market valuation** and must never be
  presented as one.
- Evidence claims must be classified (verified complete / verified partial /
  absent / not verified / not applicable / premature) and never upgraded
  because a document merely says something exists.

## Review cadence (see `VALUE_DELTA_POLICY.md`)

Ordinary PR → nothing. Materially relevant PR → brief note in the PR
description. Milestone/release/real deployment/external audit/incident →
full Value Delta. Quarterly or major gate → Acquisition Score refresh.
Before any real data room → comprehensive professional review.

## Relationship to the Validation Gate

Acquisition readiness **consumes** Validation Gate evidence
(`docs/VALIDATION_GATE.md`, reports under `artifacts/validation/`); it never
builds a second validation framework. A PR-mode PASS proves the codebase
validates itself — it does **not** prove production readiness, market demand,
IP ownership, infrastructure transferability, or financial value.
