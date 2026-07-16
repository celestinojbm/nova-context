/**
 * Validation Gate v0 (M17B) — shared types.
 *
 * A thin orchestration layer over the validation that ALREADY exists in the
 * repo (build/typecheck/test/test:integration, ops:preflight, ops:smoke,
 * backup:verify, restore guard, media:verify). It adds consistent outcome
 * semantics + reports; it reimplements no product or test logic.
 */

export type Mode = "pr" | "predeploy" | "postdeploy" | "recovery";

export type CheckStatus = "passed" | "failed" | "blocked" | "skipped" | "degraded";

export type Outcome = "PASS" | "CONDITIONAL_PASS" | "FAIL" | "BLOCKED";

export type Severity = "P0" | "P1" | "P2" | "P3";

export type Category =
  | "build"
  | "typecheck"
  | "unit"
  | "integration"
  | "functional"
  | "isolation"
  | "security"
  | "adversarial"
  | "privacy"
  | "media"
  | "backup"
  | "recovery"
  | "performance"
  | "operations";

/** Categories whose failures can never be waved through as CONDITIONAL_PASS,
 * whatever the severity — per the M17B blocking rules. */
export const PROTECTED_CATEGORIES: ReadonlySet<Category> = new Set([
  "security",
  "privacy",
  "isolation",
  "adversarial",
  "media",
  "backup",
  "recovery",
]);

/** Structured skip provenance (M17B.1 finding 4). Skip legitimacy is typed —
 * never inferred from free-text summaries. */
export type SkipReason = "cascade" | "explicit_optional" | "not_applicable";

export interface CheckResult {
  id: string;
  name: string;
  category: Category;
  severity: Severity;
  required: boolean;
  status: CheckStatus;
  duration_ms: number;
  /** One-line human summary. Sanitized. */
  summary: string;
  /** Sanitized stdout/stderr excerpt or structured note. Never raw output. */
  evidence: string;
  /** Set iff status === "skipped". A REQUIRED check may only be skipped as a
   * `cascade` from an earlier failed/blocked required check. */
  skip_reason?: SkipReason;
  /** For cascade skips: the id of the earlier required check that failed or
   * blocked. Must exist earlier in the same report or the skip is invalid. */
  caused_by_check_id?: string;
}

/** Outcome of a check body: everything but identity/timing. */
export interface CheckOutcome {
  status: CheckStatus;
  summary: string;
  evidence?: string;
  /** Required when status === "skipped" from a check fn (an optional,
   * deliberate skip); cascade skips are stamped by the runner itself. */
  skipReason?: SkipReason;
  /** Names (never values) that block the run, e.g. missing env vars. */
  blockingReasons?: string[];
  /** Non-blocking observations surfaced in the report. */
  warnings?: string[];
  /** Numeric observations, merged into report.metrics (status: observed). */
  metrics?: Record<string, number>;
}

export interface CommandSpec {
  cmd: string;
  args: string[];
  /** Extra env vars (merged over process.env). Values are treated as secret
   * by the sanitizer when they look secret-shaped. */
  env?: Record<string, string>;
  /** Expected-failure mode: the check PASSES only if the command exits
   * non-zero (e.g. wrong-key backup:verify). Unexpected success FAILS. */
  expectFailure?: boolean;
}

export interface CheckSpec {
  id: string;
  name: string;
  category: Category;
  severity: Severity;
  required: boolean;
  timeoutMs: number;
  /** M17B.1 finding 2: a PURE check inspects only local configuration (env,
   * flags) — no infrastructure, no child processes with side effects. Pure
   * checks ALWAYS run, even after an earlier required check failed/blocked,
   * so an unsafe supplied configuration is reported (FAIL) even when
   * unrelated prerequisites are missing. Cascade-skipping applies only to
   * non-pure checks. */
  pure?: boolean;
  /** Either a child-process command… */
  command?: CommandSpec;
  /** …or an in-process function (prerequisite/posture/http checks). */
  fn?: (ctx: RunContext) => Promise<CheckOutcome>;
}

export interface RunContext {
  repoRoot: string;
  mode: Mode;
  /** Parsed CLI flags (e.g. base-url, backup-dir, stamp, invite). */
  flags: Record<string, string>;
  env: NodeJS.ProcessEnv;
  runCommand: CommandRunner;
}

export interface CommandResult {
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Sanitized, size-capped excerpts — never full raw output. */
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export type CommandRunner = (
  spec: CommandSpec,
  opts: { timeoutMs: number; cwd: string },
) => Promise<CommandResult>;

export interface RunReport {
  schema_version: 1;
  run_id: string;
  mode: Mode;
  git_sha: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  outcome: Outcome;
  checks: CheckResult[];
  summary: {
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    degraded: number;
  };
  blocking_reasons: string[];
  warnings: string[];
  /** Durations/counts. No baseline SLAs in v0: values are observed, not
   * blocking (except the explicit v0 thresholds like timeouts). */
  metrics: Record<string, number>;
}
