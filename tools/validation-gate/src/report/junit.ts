import type { RunReport } from "../types.js";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * JUnit XML: one <testcase> per validation check so GitHub Actions (and any
 * JUnit viewer) surfaces the individual failing checks.
 *   passed   → plain testcase
 *   failed   → <failure>
 *   blocked  → <failure> with an explicit BLOCKED message (blocked must be
 *              loud in CI, never silently green)
 *   skipped  → <skipped>
 *   degraded → testcase with a <system-out> warning (unless required, which
 *              config never produces for degraded)
 */
export function toJUnit(report: RunReport): string {
  const cases = report.checks
    .map((c) => {
      const name = `${c.id}: ${c.name}`;
      const open = `  <testcase classname="validation-gate.${esc(report.mode)}" name="${esc(name)}" time="${(c.duration_ms / 1000).toFixed(3)}">`;
      if (c.status === "failed") {
        return `${open}\n    <failure message="${esc(c.summary)}">${esc(c.evidence)}</failure>\n  </testcase>`;
      }
      if (c.status === "blocked") {
        return `${open}\n    <failure message="BLOCKED: ${esc(c.summary)}">${esc(
          "BLOCKED is not a pass — an operator-controlled prerequisite is missing.",
        )}</failure>\n  </testcase>`;
      }
      if (c.status === "skipped") {
        return `${open}\n    <skipped message="${esc(c.summary)}"/>\n  </testcase>`;
      }
      if (c.status === "degraded") {
        return `${open}\n    <system-out>${esc(`DEGRADED: ${c.summary}`)}</system-out>\n  </testcase>`;
      }
      return `${open}</testcase>`;
    })
    .join("\n");

  const failures = report.summary.failed + report.summary.blocked;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="validation-gate" tests="${report.checks.length}" failures="${failures}" skipped="${report.summary.skipped}" time="${(report.duration_ms / 1000).toFixed(3)}">
<testsuite name="validation-gate.${esc(report.mode)}" tests="${report.checks.length}" failures="${failures}" skipped="${report.summary.skipped}" timestamp="${esc(report.started_at)}" time="${(report.duration_ms / 1000).toFixed(3)}">
${cases}
</testsuite>
</testsuites>
`;
}
