# Value Delta Policy (M17C)

A lightweight, permanent policy for tracking how changes affect Nova's value
as a transferable asset — **without** bureaucratizing ordinary development.
The Acquisition Score is never a market valuation, and the project is never
optimized solely to raise it.

## Cadence

**No Value Delta required** — typo/formatting fixes; routine dependency
patches with no material effect; small UI polish; internal cleanup with no
acquisition impact. (Ordinary PRs: no score recalculation, nothing to write.)

**Brief Value Delta note** (1–5 lines, in the PR description) — for a
materially relevant PR that changes: architecture; security; reliability;
transferability; dependencies (new provider, license class, or removal);
operating cost; external providers; technical debt (added or retired).

**Full Value Delta** — after: a milestone; a release; a real deployment; an
external audit; a security incident; a material architecture migration; a
major provider change; or any deliberate Acquisition Score reassessment
(quarterly or at major gates).

## A full Value Delta must include

prior score → current score; per-category changes; confidence; evidence
added (with EVIDENCE_INDEX updates); risk reduced; risk introduced;
maintenance impact; transferability impact; buyer impact; neutral changes;
and **one next best investment**.

It must distinguish: real value change · temporary planned score reduction
(e.g. mid-migration) · unplanned deterioration · score change caused only by
new evidence (the asset didn't change; our knowledge did).

## Baseline entry (M17C — initial)

- **Baseline established:** score 59/100 at `74ac864c` (2026-07-16).
- **Comparison confidence:** not applicable (no prior reliable score exists;
  no earlier number may be cited as one).
- **Technical value added by M17C itself:** evidence organization, risk
  visibility, transferability planning.
- **Financial value change:** not determined.
- **Score increase claimed:** none — creating the score is not an increase.
- **M17C.1 accuracy corrections (same PR, pre-merge):** stale residual
  status fixed (backup:seal symlink item closed by M16 hardening) and
  ownership/licensing conflation separated (R-01 vs. R-13). Score unchanged
  at 59 — a documentation/evidence correction, not a value change.

The first true Value Delta will compare a later milestone against THIS
baseline.
