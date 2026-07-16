import type { RunReport } from "../types.js";

const VERDICT_LINE: Record<RunReport["outcome"], string> = {
  PASS: "✅ **GO** — all mandatory checks ran and passed.",
  CONDITIONAL_PASS:
    "🟡 **GO (conditional)** — mandatory checks passed; an explicitly allowed optional capability is disabled/degraded.",
  FAIL: "❌ **NO-GO** — at least one required check ran and failed.",
  BLOCKED:
    "⛔ **BLOCKED** — the gate could not run: operator-controlled prerequisites are missing. BLOCKED is NOT a pass.",
};

/** Human-readable Markdown report. All strings inside `report` are already
 * sanitized by the runner. */
export function toMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Validation Gate — ${report.mode} — ${report.outcome}`);
  lines.push("");
  lines.push(VERDICT_LINE[report.outcome]);
  lines.push("");
  lines.push(`- **Mode:** ${report.mode}`);
  lines.push(`- **Run:** \`${report.run_id}\``);
  lines.push(`- **Git SHA:** \`${report.git_sha}\``);
  lines.push(`- **Started:** ${report.started_at}`);
  lines.push(`- **Duration:** ${Math.round(report.duration_ms / 1000)}s`);
  lines.push(
    `- **Checks:** ${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.blocked} blocked · ${report.summary.skipped} skipped · ${report.summary.degraded} degraded`,
  );
  lines.push("");

  if (report.blocking_reasons.length) {
    lines.push("## Blocking reasons");
    lines.push("");
    for (const r of report.blocking_reasons) lines.push(`- ${r}`);
    lines.push("");
  }

  const notable = report.checks.filter((c) => c.status !== "passed");
  if (notable.length) {
    lines.push("## Failed / blocked / skipped / degraded checks");
    lines.push("");
    lines.push("| check | severity | required | status | summary |");
    lines.push("|---|---|---|---|---|");
    for (const c of notable) {
      lines.push(
        `| \`${c.id}\` | ${c.severity} | ${c.required ? "yes" : "no"} | **${c.status}** | ${c.summary.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## All checks");
  lines.push("");
  lines.push("| check | category | severity | status | duration |");
  lines.push("|---|---|---|---|---|");
  for (const c of report.checks) {
    lines.push(`| \`${c.id}\` | ${c.category} | ${c.severity} | ${c.status} | ${c.duration_ms}ms |`);
  }
  lines.push("");

  if (report.warnings.length) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  const metricKeys = Object.keys(report.metrics).sort();
  if (metricKeys.length) {
    lines.push("## Metrics (observed — no baseline SLAs in v0)");
    lines.push("");
    lines.push("| metric | value |");
    lines.push("|---|---|");
    for (const k of metricKeys) lines.push(`| ${k} | ${report.metrics[k]} |`);
    lines.push("");
  }

  lines.push("## Recommended next action");
  lines.push("");
  lines.push(
    report.outcome === "PASS" || report.outcome === "CONDITIONAL_PASS"
      ? "Proceed to the next gate step for this mode (see docs/VALIDATION_GATE.md). Real alpha remains gated on the full M16 checklist + explicit operator approval."
      : report.outcome === "BLOCKED"
        ? "Supply the missing operator prerequisites (names above — never commit or print their values), then re-run this mode."
        : "Fix the failed check(s) above and re-run. Do not merge/deploy on a FAIL.",
  );
  lines.push("");
  return lines.join("\n");
}
