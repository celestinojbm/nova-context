import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitize } from "./sanitization.js";

/**
 * M18A.3 §3: the SINGLE executable remote-recovery orchestration. One command
 * for a real S3/R2 recovery drill — the operator never hand-composes
 * `backup:fetch-s3 && mkdir && validate:recovery --backup-dir=… && rm -rf`.
 *
 *   validate:recovery-remote -- --stamp=<s> --restored-base-url=<url> [--invite=<code>]
 *
 * It: (1) creates a NEW private 0700 temporary recovery dir (never an operator-
 * supplied path; not a symlink; not pre-existing); (2) fetches the COMMITTED
 * sealed set from S3/R2, authenticating the remote marker + verifying every
 * artifact + running the local `backup:verify` (via backup:fetch-s3); (3)
 * invokes the Validation Gate `recovery` mode against that exact directory (DB
 * + media restore in the corrected order); (4) preserves ONLY the gate's
 * sanitized reports; (5) removes the temporary directory in a finally, ALWAYS,
 * reporting any cleanup failure explicitly; (6) exits non-zero on FAIL/BLOCKED.
 *
 * The `remote_fetch` and `remote_workspace_cleanup` steps are printed as
 * explicit orchestration evidence. Remote mode NEVER accepts an arbitrary
 * existing `--out`; local recovery mode (`validate:recovery`) is unchanged.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

/**
 * NCA-17-001 terminal-exit rule, isolated + pure for exhaustive testing. The
 * process may exit 0 ONLY when the recovery gate returned success (resultCode
 * 0) AND the temporary workspace cleanup succeeded. Any non-zero gate outcome
 * (FAIL/BLOCKED/fetch-failure) OR a cleanup failure yields a non-zero code; a
 * zero result with a failed cleanup is forced to 1.
 */
export function computeExit(resultCode: number, cleanupOk: boolean): number {
  if (!cleanupOk) return resultCode === 0 ? 1 : resultCode;
  return resultCode === 0 ? 0 : resultCode || 1;
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main(): Promise<void> {
  const stamp = arg("stamp");
  const restoredBase = arg("restored-base-url");
  if (!stamp || !restoredBase) {
    console.error("usage: validate:recovery-remote -- --stamp=<s> --restored-base-url=<url> [--invite=<code>]");
    process.exitCode = 2;
    return;
  }
  const invite = arg("invite");

  console.log("validation-gate: mode=recovery-remote (single orchestration; synthetic data only, ever)");

  // (1) A NEW private 0700 workspace. mkdtemp creates a fresh, unique, non-pre-
  // existing directory; chmod 0700; lstat confirms a real dir (not a symlink).
  const ws = mkdtempSync(join(tmpdir(), "nova-recovery-remote-"));
  chmodSync(ws, 0o700);
  const st = lstatSync(ws);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    console.error("  ✗ remote_workspace: refusing — workspace is not a real private directory");
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort — refuse regardless */
    }
    process.exitCode = 1;
    return;
  }
  console.log("  ✓ remote_workspace: created a new private 0700 recovery directory");

  // NCA-17-001 (M18A.4 P1-1): a SINGLE terminal exit path. `resultCode` starts
  // at a FAILURE value; the process may end with 0 ONLY after (a) the recovery
  // gate returned success AND (b) the temporary workspace cleanup succeeded.
  // There is NO `return` inside the orchestration try — every branch (fetch
  // non-zero, fetch throw, gate FAIL/BLOCKED, any exception) leaves `resultCode`
  // non-zero, the finally ALWAYS runs cleanup, a cleanup failure UPGRADES the
  // result to non-zero, and process.exitCode is set exactly once after cleanup.
  let resultCode = 1;
  let cleanupOk = false;
  try {
    // (2) Fetch the committed sealed set (marker auth + per-artifact verify +
    // local backup:verify). --out keeps the files for the restore step.
    console.log(`  → remote_fetch: fetching the committed sealed set (stamp ${stamp})`);
    const fetchCode = await run("pnpm", [
      "--filter",
      "@nova/api",
      "--silent",
      "backup:fetch-s3",
      "--",
      `--stamp=${stamp}`,
      `--out=${ws}`,
    ]);
    if (fetchCode !== 0) {
      console.error("  ✗ remote_fetch FAILED — refusing recovery against an unavailable/uncommitted set");
      resultCode = fetchCode || 1; // guaranteed non-zero; NO early return
    } else {
      console.log("  ✓ remote_fetch: committed set fetched + verified");

      // (3) Invoke the Validation Gate recovery mode against the fetched dir.
      const gateArgs = [
        join(import.meta.dirname, "cli.ts"),
        "recovery",
        `--backup-dir=${ws}`,
        `--stamp=${stamp}`,
        `--restored-base-url=${restoredBase}`,
      ];
      if (invite) gateArgs.push(`--invite=${invite}`);
      // The gate's own exit code carries PASS (0) / FAIL / BLOCKED (non-zero).
      resultCode = await run("tsx", gateArgs);
    }
  } catch (err) {
    // (4) A thrown exception anywhere in orchestration is sanitized and becomes
    // a non-zero result — it can never fall through to a zero exit.
    console.error(`  ✗ remote_recovery error: ${sanitize((err as Error).message)}`);
    resultCode = 1;
  } finally {
    // (5) ALWAYS remove the temporary workspace; report cleanup failure loudly.
    try {
      rmSync(ws, { recursive: true, force: true });
      // TEST-ONLY, FAIL-SAFE-ONLY affordance: the real rmSync above ALWAYS runs
      // first (so no plaintext is ever left behind); this hook can then force
      // the cleanup-failure branch so the terminal invariant is exercisable by
      // the real CLI process. It can only UPGRADE the outcome to non-zero — it
      // can never weaken a guard or produce a false success/exit-0.
      if (process.env.NOVA_RECOVERY_REMOTE_FORCE_CLEANUP_FAILURE === "1") {
        throw new Error("forced cleanup failure (test hook)");
      }
      cleanupOk = true;
      console.log("  ✓ remote_workspace_cleanup: temporary recovery workspace removed");
    } catch (err) {
      cleanupOk = false;
      console.error(`  ✗ remote_workspace_cleanup FAILED: ${sanitize((err as Error).message)}`);
    }
  }

  // (6) SINGLE terminal exit, set exactly once AFTER cleanup, via the pure rule.
  process.exitCode = computeExit(resultCode, cleanupOk);
}

// Only auto-run as the CLI entrypoint (not when imported for unit tests).
const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) main().catch((err) => {
  // Defence in depth: any escape from main() is a non-zero failure, never 0.
  console.error(`validate:recovery-remote crashed: ${sanitize((err as Error).message)}`);
  process.exitCode = 1;
});
