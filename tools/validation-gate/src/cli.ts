import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./checks/command.js";
import { exitCodeFor } from "./outcome.js";
import { toJson } from "./report/json.js";
import { toJUnit } from "./report/junit.js";
import { toMarkdown } from "./report/markdown.js";
import { runGate } from "./runner.js";
import type { Mode, RunContext } from "./types.js";

const HELP = `nova validation gate v0 (M17B)

Usage:
  pnpm validate:pr
  pnpm validate:predeploy
  pnpm validate:postdeploy -- --base-url=https://api.example.com [--invite=<code>]
                              (NOVA_VALIDATE_SESSION_TOKEN required — the
                               authenticated /v1/ops/status check is mandatory)
  pnpm validate:recovery   -- --backup-dir=/secure/path --stamp=<stamp> \
                              --restored-base-url=http://localhost:<port>
                              (post-restore smoke against the restored scratch
                               stack is mandatory for a recovery PASS)

Outcomes:
  PASS              all mandatory checks ran and passed
  CONDITIONAL_PASS  mandatory checks passed; an explicitly allowed optional
                    capability is disabled/degraded (never hides a failure)
  FAIL              a required check ran and failed — fix before merge/deploy
  BLOCKED           operator-controlled prerequisites are missing; the gate
                    could not run. BLOCKED is NOT a pass and exits non-zero.

Exit codes: PASS/CONDITIONAL_PASS 0 · FAIL 1 · BLOCKED 1 (pr mode) / 2 (other modes)

Prerequisites per mode:
  pr          local/CI Postgres + Redis only (no cloud credentials, ever)
  predeploy   NODE_ENV=production + operator secrets present (names checked,
              values never printed). Pure config-safety checks run even when
              infrastructure values are missing — unsafe supplied config is
              FAIL, missing infra is BLOCKED (FAIL wins).
  postdeploy  a REAL deployed Nova API (--base-url), an invite for the
              SYNTHETIC smoke account, and NOVA_VALIDATE_SESSION_TOKEN (the
              authenticated /v1/ops/status check is mandatory). Synthetic
              data only — the smoke account self-deletes. NO real user data.
  recovery    a sealed backup (--backup-dir/--stamp), NOVA_BACKUP_KEY,
              NOVA_ENCRYPTION_KEY, a SCRATCH DATABASE_URL (the restore guard
              refuses non-local targets), and --restored-base-url for the
              MANDATORY post-restore smoke. Never restores production.

Reports (never contain secrets or captured content):
  artifacts/validation/<run-id>/report.json | report.md | junit.xml
  artifacts/validation/latest.json | latest.md

Flags: --help · --debug (local only: echoes sanitized check evidence; refused in CI)
`;

function parseArgs(argv: string[]): { mode: Mode | null; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let mode: Mode | null = null;
  for (const a of argv) {
    if (a === "pr" || a === "predeploy" || a === "postdeploy" || a === "recovery") mode = a;
    else if (a.startsWith("--")) {
      const [k, ...rest] = a.slice(2).split("=");
      if (k) flags[k] = rest.length ? rest.join("=") : "true";
    }
  }
  return { mode, flags };
}

async function main(): Promise<void> {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  if (flags.help !== undefined || !mode) {
    process.stdout.write(HELP);
    process.exit(mode ? 0 : flags.help !== undefined ? 0 : 2);
  }

  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  const debug = flags.debug === "true" && !process.env.CI;
  if (flags.debug === "true" && process.env.CI) {
    console.error("--debug is refused in CI (verbose local-only mode; output stays sanitized regardless).");
  }

  const ctx: RunContext = { repoRoot, mode, flags, env: process.env, runCommand };
  console.log(`validation-gate: mode=${mode} (see --help for outcome semantics; no real user data, ever)`);
  const report = await runGate({ mode, ctx });

  // Write reports.
  const outRoot = process.env.NOVA_VALIDATE_OUT_DIR ?? join(repoRoot, "artifacts", "validation");
  const runDir = join(outRoot, report.run_id);
  mkdirSync(runDir, { recursive: true });
  const jsonPath = join(runDir, "report.json");
  const mdPath = join(runDir, "report.md");
  writeFileSync(jsonPath, toJson(report));
  writeFileSync(mdPath, toMarkdown(report));
  writeFileSync(join(runDir, "junit.xml"), toJUnit(report));
  copyFileSync(jsonPath, join(outRoot, "latest.json"));
  copyFileSync(mdPath, join(outRoot, "latest.md"));

  // Console summary (sanitized fields only).
  for (const c of report.checks) {
    const mark =
      c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : c.status === "blocked" ? "⛔" : c.status === "degraded" ? "▽" : "→";
    console.log(`  ${mark} [${c.status}] ${c.id} (${c.duration_ms}ms) — ${c.summary}`);
    if (debug && c.evidence) console.log(`      ${c.evidence.split("\n").join("\n      ")}`);
  }
  for (const r of report.blocking_reasons) console.log(`  blocking: ${r}`);
  for (const w of report.warnings) console.log(`  warning: ${w}`);
  console.log(`\nOUTCOME: ${report.outcome} (mode=${mode})`);
  console.log(`reports: ${runDir}`);
  if (report.outcome === "CONDITIONAL_PASS") {
    console.log("note: CONDITIONAL_PASS — an allowed optional capability is disabled/degraded; mandatory checks all passed.");
  }
  if (report.outcome === "BLOCKED") {
    console.log("note: BLOCKED is not a pass — supply the missing operator prerequisites and re-run.");
  }
  process.exit(exitCodeFor(report.outcome, mode));
}

main().catch((err) => {
  console.error(`validation-gate crashed: ${(err as Error).message}`);
  process.exit(1);
});
