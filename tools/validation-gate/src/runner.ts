import { execFileSync } from "node:child_process";
import { timeoutFor } from "./config.js";
import { describeCommand } from "./checks/command.js";
import { computeOutcome } from "./outcome.js";
import { sanitize } from "./sanitization.js";
import type {
  CheckResult,
  CheckSpec,
  Mode,
  RunContext,
  RunReport,
} from "./types.js";

/**
 * Sequential check runner (M17B).
 *
 * - Checks run in config order. When a REQUIRED check fails or blocks, the
 *   remaining checks are recorded as `skipped` with a documented cascade
 *   reason — the causing check already decides the outcome, and running an
 *   integration suite on a broken build only wastes CI minutes.
 * - Every summary/evidence string is sanitized; blocking reasons carry
 *   prerequisite NAMES, never values.
 * - Vitest totals are parsed opportunistically into metrics (observed only).
 */

export interface RunOptions {
  mode: Mode;
  ctx: RunContext;
  checks?: CheckSpec[]; // injectable for tests
  now?: () => number;
}

export async function runGate(opts: RunOptions): Promise<RunReport> {
  const { ctx, mode } = opts;
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now());
  const specs = opts.checks ?? (await import("./config.js")).checksForMode(mode, ctx);

  const results: CheckResult[] = [];
  const blockingReasons: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number> = {};
  let cascadeFrom: { id: string; status: "failed" | "blocked" } | null = null;

  for (const spec of specs) {
    if (cascadeFrom) {
      results.push({
        ...identity(spec),
        status: "skipped",
        duration_ms: 0,
        summary: `not run: prior required check '${cascadeFrom.id}' ${cascadeFrom.status}`,
        evidence: "",
      });
      continue;
    }

    const started = now();
    let result: CheckResult;
    try {
      if (spec.command) {
        const res = await ctx.runCommand(spec.command, {
          timeoutMs: timeoutFor(spec, ctx.env),
          cwd: ctx.repoRoot,
        });
        const ok = spec.command.expectFailure
          ? res.code !== 0 && res.code !== null && !res.timedOut
          : res.code === 0;
        const status = res.timedOut ? "failed" : ok ? "passed" : "failed";
        const summary = res.timedOut
          ? `timed out after ${timeoutFor(spec, ctx.env)}ms: ${describeCommand(spec.command)}`
          : spec.command.expectFailure
            ? ok
              ? `failed as expected (exit ${res.code}): ${describeCommand(spec.command)}`
              : res.code === 0
                ? `UNEXPECTED SUCCESS (must fail): ${describeCommand(spec.command)}`
                : `did not run to a clean expected failure: ${describeCommand(spec.command)}`
            : ok
              ? `exit 0 in ${res.durationMs}ms: ${describeCommand(spec.command)}`
              : `exit ${res.code} in ${res.durationMs}ms: ${describeCommand(spec.command)}`;
        result = {
          ...identity(spec),
          status,
          duration_ms: res.durationMs,
          summary: sanitize(summary),
          evidence: status === "passed" ? tail(res.stdoutExcerpt) : `${tail(res.stdoutExcerpt)}\n${tail(res.stderrExcerpt)}`.trim(),
        };
        parseVitestTotals(res.stdoutExcerpt, spec.id, metrics);
        metrics[`${spec.id}_duration_ms`] = res.durationMs;
      } else if (spec.fn) {
        const out = await spec.fn(ctx);
        result = {
          ...identity(spec),
          status: out.status,
          duration_ms: now() - started,
          summary: sanitize(out.summary),
          evidence: sanitize(out.evidence ?? ""),
        };
        for (const r of out.blockingReasons ?? []) blockingReasons.push(sanitize(r));
        for (const w of out.warnings ?? []) warnings.push(sanitize(w));
        Object.assign(metrics, out.metrics);
      } else {
        result = {
          ...identity(spec),
          status: "failed",
          duration_ms: 0,
          summary: "invalid check spec: neither command nor fn",
          evidence: "",
        };
      }
    } catch (err) {
      result = {
        ...identity(spec),
        status: "failed",
        duration_ms: now() - started,
        summary: sanitize(`check threw: ${(err as Error).message}`),
        evidence: "",
      };
    }

    results.push(result);
    if (spec.required && (result.status === "failed" || result.status === "blocked")) {
      cascadeFrom = { id: spec.id, status: result.status };
      if (result.status === "blocked" && !hasReasonFor(blockingReasons, spec.id)) {
        blockingReasons.push(sanitize(`${spec.id}: ${result.summary}`));
      }
      if (result.status === "failed") {
        // failures are visible via the check itself; no blocking reason entry
      }
    }
  }

  const finishedAt = new Date(now());
  const outcome = computeOutcome(results);
  const summary = {
    passed: results.filter((c) => c.status === "passed").length,
    failed: results.filter((c) => c.status === "failed").length,
    blocked: results.filter((c) => c.status === "blocked").length,
    skipped: results.filter((c) => c.status === "skipped").length,
    degraded: results.filter((c) => c.status === "degraded").length,
  };

  return {
    schema_version: 1,
    run_id: makeRunId(startedAt, ctx.repoRoot),
    mode,
    git_sha: gitSha(ctx.repoRoot),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    outcome,
    checks: results,
    summary,
    blocking_reasons: blockingReasons,
    warnings,
    metrics: { ...metrics, total_duration_ms: finishedAt.getTime() - startedAt.getTime() },
  };
}

const identity = (s: CheckSpec) => ({
  id: s.id,
  name: s.name,
  category: s.category,
  severity: s.severity,
  required: s.required,
});

const tail = (s: string, n = 1500): string => (s.length > n ? `…${s.slice(-n)}` : s);

const hasReasonFor = (reasons: string[], id: string): boolean =>
  reasons.some((r) => r.startsWith(`${id}:`));

function gitSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function makeRunId(startedAt: Date, repoRoot: string): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${gitSha(repoRoot).slice(0, 7)}`;
}

/** Opportunistic vitest summary parse — observed metrics only, never
 * blocking. Lines look like: "Tests  211 passed | 1 skipped (212)". */
function parseVitestTotals(stdout: string, checkId: string, metrics: Record<string, number>): void {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let seen = false;
  for (const m of stdout.matchAll(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/g)) {
    seen = true;
    failed += m[1] ? Number(m[1]) : 0;
    passed += Number(m[2]);
    skipped += m[3] ? Number(m[3]) : 0;
  }
  if (seen) {
    metrics[`${checkId}_tests_passed`] = passed;
    metrics[`${checkId}_tests_failed`] = failed;
    metrics[`${checkId}_tests_skipped`] = skipped;
  }
}
