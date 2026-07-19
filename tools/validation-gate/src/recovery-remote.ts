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
    process.exit(2);
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
    rmSync(ws, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("  ✓ remote_workspace: created a new private 0700 recovery directory");

  let gateCode = 1;
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
      gateCode = fetchCode;
      return;
    }
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
    gateCode = await run("tsx", gateArgs);
  } finally {
    // (5) ALWAYS remove the temporary workspace; report cleanup failure loudly.
    try {
      rmSync(ws, { recursive: true, force: true });
      cleanupOk = true;
      console.log("  ✓ remote_workspace_cleanup: temporary recovery workspace removed");
    } catch (err) {
      console.error(`  ✗ remote_workspace_cleanup FAILED: ${sanitize((err as Error).message)}`);
    }
  }

  // (6) Non-zero on gate FAIL/BLOCKED (its exit code) OR a cleanup failure.
  if (!cleanupOk) process.exit(1);
  process.exit(gateCode);
}

main().catch((err) => {
  console.error(`validate:recovery-remote crashed: ${sanitize((err as Error).message)}`);
  process.exit(1);
});
