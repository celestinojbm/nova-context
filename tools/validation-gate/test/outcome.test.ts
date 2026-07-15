import { describe, expect, it } from "vitest";
import { computeOutcome, exitCodeFor } from "../src/outcome.js";
import type { CheckResult } from "../src/types.js";

const check = (over: Partial<CheckResult>): CheckResult => ({
  id: "c",
  name: "c",
  category: "unit",
  severity: "P1",
  required: true,
  status: "passed",
  duration_ms: 1,
  summary: "ok",
  evidence: "",
  ...over,
});

describe("outcome semantics (M17B §4–§5)", () => {
  it("all mandatory checks pass → PASS", () => {
    expect(computeOutcome([check({}), check({ id: "d" })])).toBe("PASS");
  });

  it("required P1 failure → FAIL", () => {
    expect(computeOutcome([check({}), check({ id: "d", status: "failed", severity: "P1" })])).toBe("FAIL");
  });

  it("required P2 failure → FAIL", () => {
    expect(computeOutcome([check({ status: "failed", severity: "P2", required: true })])).toBe("FAIL");
  });

  it("optional feature degraded → CONDITIONAL_PASS (never hides a failure)", () => {
    expect(
      computeOutcome([check({}), check({ id: "posture", status: "degraded", severity: "P3", required: false })]),
    ).toBe("CONDITIONAL_PASS");
    // degraded + a real failure is still FAIL
    expect(
      computeOutcome([
        check({ status: "failed" }),
        check({ id: "posture", status: "degraded", severity: "P3", required: false }),
      ]),
    ).toBe("FAIL");
  });

  it("non-protected P3 failure → CONDITIONAL_PASS; protected-category P3 failure → FAIL", () => {
    expect(
      computeOutcome([check({ status: "failed", severity: "P3", required: false, category: "performance" })]),
    ).toBe("CONDITIONAL_PASS");
    for (const category of ["security", "privacy", "isolation", "backup", "recovery", "media", "adversarial"] as const) {
      expect(computeOutcome([check({ status: "failed", severity: "P3", required: false, category })])).toBe("FAIL");
    }
  });

  it("required check blocked → BLOCKED (never PASS); failure outranks blocked", () => {
    expect(computeOutcome([check({ status: "blocked" })])).toBe("BLOCKED");
    expect(computeOutcome([check({ status: "blocked" }), check({ id: "d", status: "failed" })])).toBe("FAIL");
  });

  it("required skip WITHOUT documented reason cannot PASS", () => {
    expect(computeOutcome([check({ status: "skipped", summary: "" })])).toBe("BLOCKED");
    // documented cascade/optional skips don't flip a PASS on their own
    expect(
      computeOutcome([check({}), check({ id: "d", status: "skipped", required: false, summary: "safe: not applicable" })]),
    ).toBe("PASS");
  });
});

describe("exit codes (M17B §12)", () => {
  it("PR mode: PASS/CONDITIONAL_PASS → 0, FAIL → 1, BLOCKED → 1", () => {
    expect(exitCodeFor("PASS", "pr")).toBe(0);
    expect(exitCodeFor("CONDITIONAL_PASS", "pr")).toBe(0);
    expect(exitCodeFor("FAIL", "pr")).toBe(1);
    expect(exitCodeFor("BLOCKED", "pr")).toBe(1); // a blocked mandatory PR check must not merge
  });

  it("operator modes: BLOCKED → 2 (distinct from FAIL)", () => {
    expect(exitCodeFor("BLOCKED", "predeploy")).toBe(2);
    expect(exitCodeFor("FAIL", "recovery")).toBe(1);
    expect(exitCodeFor("PASS", "postdeploy")).toBe(0);
  });
});
