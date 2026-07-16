import { describe, expect, it } from "vitest";
import { toJson } from "../src/report/json.js";
import { toJUnit } from "../src/report/junit.js";
import { toMarkdown } from "../src/report/markdown.js";
import type { RunReport } from "../src/types.js";

const report: RunReport = {
  schema_version: 1,
  run_id: "2026-07-11T00-00-00-000Z-abc1234",
  mode: "predeploy",
  git_sha: "abc1234def",
  started_at: "2026-07-11T00:00:00.000Z",
  finished_at: "2026-07-11T00:00:05.000Z",
  duration_ms: 5000,
  outcome: "BLOCKED",
  checks: [
    {
      id: "predeploy_prerequisites",
      name: "Operator prerequisites present",
      category: "operations",
      severity: "P0",
      required: true,
      status: "blocked",
      duration_ms: 3,
      summary: "operator prerequisites missing (2) — see blocking reasons",
      evidence: "",
    },
    {
      id: "preflight",
      name: "ops:preflight",
      category: "operations",
      severity: "P0",
      required: true,
      status: "skipped",
      duration_ms: 0,
      summary: "not run: prior required check 'predeploy_prerequisites' blocked",
      evidence: "",
      skip_reason: "cascade",
      caused_by_check_id: "predeploy_prerequisites",
    },
    {
      id: "feature_posture",
      name: "feature posture",
      category: "operations",
      severity: "P3",
      required: false,
      status: "degraded",
      duration_ms: 1,
      summary: "enabled beyond first-deploy posture: live_qa",
      evidence: "",
    },
  ],
  summary: { passed: 0, failed: 0, blocked: 1, skipped: 1, degraded: 1 },
  blocking_reasons: ["missing env: DATABASE_URL", "missing env: NOVA_BACKUP_KEY"],
  warnings: ["feature enabled at deploy gate: live_qa"],
  metrics: { total_duration_ms: 5000 },
};

describe("report generation (M17B §7)", () => {
  it("JSON conforms to the schema shape (stable top-level keys + check fields)", () => {
    const parsed = JSON.parse(toJson(report)) as RunReport;
    for (const key of [
      "schema_version",
      "run_id",
      "mode",
      "git_sha",
      "started_at",
      "finished_at",
      "duration_ms",
      "outcome",
      "checks",
      "summary",
      "blocking_reasons",
      "warnings",
      "metrics",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.schema_version).toBe(1);
    for (const c of parsed.checks) {
      for (const f of ["id", "name", "category", "severity", "required", "status", "duration_ms", "summary", "evidence"]) {
        expect(c).toHaveProperty(f);
      }
    }
    for (const f of ["passed", "failed", "blocked", "skipped", "degraded"]) {
      expect(parsed.summary).toHaveProperty(f);
    }
  });

  it("Markdown contains the verdict, mode, sha, blocking reasons, totals, and next action", () => {
    const md = toMarkdown(report);
    expect(md).toContain("BLOCKED");
    expect(md).toContain("BLOCKED is NOT a pass");
    expect(md).toContain("predeploy");
    expect(md).toContain("abc1234def");
    expect(md).toContain("missing env: DATABASE_URL");
    expect(md).toContain("0 passed · 0 failed · 1 blocked · 1 skipped · 1 degraded");
    expect(md).toContain("Recommended next action");
  });

  it("JUnit has one testcase per check; blocked surfaces as a loud failure; degraded as system-out", () => {
    const xml = toJUnit(report);
    expect(xml.match(/<testcase /g)).toHaveLength(3);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain("BLOCKED:");
    expect(xml).toContain("<skipped");
    expect(xml).toContain("DEGRADED:");
    // escaping sanity
    expect(xml).not.toContain("& ");
  });

  it("JSON reports include structured skip provenance (M17B.1 finding 4)", () => {
    const parsed = JSON.parse(toJson(report)) as RunReport;
    const skipped = parsed.checks.find((c) => c.id === "preflight");
    expect(skipped?.skip_reason).toBe("cascade");
    expect(skipped?.caused_by_check_id).toBe("predeploy_prerequisites");
  });

  it("artifact naming is deterministic and path-safe", () => {
    expect(report.run_id).toMatch(/^[0-9T\-Z]+-[0-9a-f]{7}$/);
    expect(report.run_id).not.toMatch(/[/\\:.]/);
  });

  it("reports never contain data URLs even if a check summary slipped one in pre-sanitizer (belt-and-braces)", () => {
    // The runner sanitizes before building the report; this asserts our
    // fixture discipline: nothing data:-URL-shaped is present in any format.
    for (const rendered of [toJson(report), toMarkdown(report), toJUnit(report)]) {
      expect(rendered).not.toMatch(/data:image/i);
    }
  });
});
