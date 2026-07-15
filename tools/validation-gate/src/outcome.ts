import {
  PROTECTED_CATEGORIES,
  type CheckResult,
  type Outcome,
} from "./types.js";

/**
 * Outcome computation (M17B §4–§5).
 *
 *   FAIL             — any failed P0/P1 check; any failed REQUIRED P2 check;
 *                      any P3 failure touching a protected category
 *                      (security/privacy/isolation/adversarial/media/backup/
 *                      recovery — these are never optional).
 *   BLOCKED          — no failure, but a required check is blocked (an
 *                      operator-controlled prerequisite does not exist), or a
 *                      required check was skipped without a documented safe
 *                      reason. BLOCKED never silently becomes PASS.
 *   CONDITIONAL_PASS — everything mandatory passed, but an explicitly allowed
 *                      optional capability is disabled/degraded, or a
 *                      non-protected P3 check failed.
 *   PASS             — all mandatory checks ran and passed.
 *
 * Precedence: FAIL > BLOCKED > CONDITIONAL_PASS > PASS. (A real failure is a
 * stronger, more actionable signal than a missing prerequisite.)
 */
export function computeOutcome(checks: CheckResult[]): Outcome {
  let failed = false;
  let blocked = false;
  let conditional = false;

  // Earlier-position statuses for validating cascade provenance (M17B.1
  // finding 4): a cascade skip must name a REQUIRED check that appears
  // EARLIER in this same report with status failed/blocked.
  const positions = new Map<string, { index: number; check: CheckResult }>();
  checks.forEach((c, index) => {
    if (!positions.has(c.id)) positions.set(c.id, { index, check: c });
  });

  checks.forEach((c, index) => {
    if (c.status === "failed") {
      const protectedCat = PROTECTED_CATEGORIES.has(c.category);
      if (c.severity === "P0" || c.severity === "P1") failed = true;
      else if (c.severity === "P2" && c.required) failed = true;
      else if (protectedCat) failed = true; // P3-but-protected is still FAIL
      else if (c.severity === "P2" && !c.required) conditional = true;
      else conditional = true; // non-protected P3 failure
    } else if (c.status === "blocked") {
      if (c.required) blocked = true;
      else conditional = true;
    } else if (c.status === "skipped") {
      if (!c.required) {
        // Optional skips (explicit_optional / not_applicable / cascade) are
        // non-blocking by definition.
        return;
      }
      // A REQUIRED check may be skipped ONLY as a structured cascade from an
      // earlier failed/blocked REQUIRED check. Free-text summaries prove
      // nothing; the typed fields do.
      const cause =
        c.skip_reason === "cascade" && c.caused_by_check_id
          ? positions.get(c.caused_by_check_id)
          : undefined;
      const validCascade =
        !!cause &&
        cause.index < index &&
        cause.check.required &&
        (cause.check.status === "failed" || cause.check.status === "blocked");
      if (!validCascade) blocked = true;
      // Valid cascades don't add anything: the causing check already drove
      // the outcome to FAIL or BLOCKED.
    } else if (c.status === "degraded") {
      conditional = true;
    }
  });

  if (failed) return "FAIL";
  if (blocked) return "BLOCKED";
  if (conditional) return "CONDITIONAL_PASS";
  return "PASS";
}

/** Exit code per mode (M17B §12). PR mode: PASS/CONDITIONAL_PASS → 0,
 * FAIL/BLOCKED → 1 (a PR must not merge on a gate that couldn't run).
 * Operator modes: FAIL → 1; BLOCKED → 2 (distinct: prerequisites missing,
 * nothing broke); PASS/CONDITIONAL_PASS → 0. */
export function exitCodeFor(outcome: Outcome, mode: string): number {
  switch (outcome) {
    case "PASS":
    case "CONDITIONAL_PASS":
      return 0;
    case "FAIL":
      return 1;
    case "BLOCKED":
      return mode === "pr" ? 1 : 2;
  }
}
