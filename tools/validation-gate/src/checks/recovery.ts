import { randomBytes } from "node:crypto";
import type { CheckOutcome, RunContext } from "../types.js";

/**
 * Recovery-drill checks (M17B §3D). Prepared in M17B; a real drill runs only
 * when the operator supplies a sealed backup and a SAFE SCRATCH target and
 * separately authorizes it. Never restores over production: the existing
 * backup:restore-guard (loopback-host + non-production classification,
 * M15-D03) is the arbiter, and the raw DATABASE_URL is never printed.
 */

export async function recoveryPrerequisites(ctx: RunContext): Promise<CheckOutcome> {
  const reasons: string[] = [];
  if (!ctx.flags["backup-dir"]) reasons.push("missing --backup-dir (no sealed backup to drill against)");
  if (!ctx.flags.stamp) reasons.push("missing --stamp (which backup set to verify/restore)");
  if (!ctx.env.NOVA_BACKUP_KEY) reasons.push("missing env: NOVA_BACKUP_KEY (cannot unseal)");
  if (!ctx.env.DATABASE_URL) reasons.push("missing env: DATABASE_URL (no scratch restore target)");
  if (!ctx.env.NOVA_ENCRYPTION_KEY) {
    reasons.push("missing env: NOVA_ENCRYPTION_KEY (media:verify after restore needs the data key)");
  }
  if (reasons.length) {
    return {
      status: "blocked",
      summary: "safe scratch recovery prerequisites unavailable",
      blockingReasons: reasons,
    };
  }
  return { status: "passed", summary: "backup set, keys, and scratch target configured (values not inspected)" };
}

/** The scratch target must classify as LOCAL SCRATCH (loopback + non-prod)
 * via the existing restore guard. A non-scratch target is a missing safe
 * prerequisite (BLOCKED) — the gate never drives a production restore. */
export async function scratchTargetGuard(ctx: RunContext): Promise<CheckOutcome> {
  const res = await ctx.runCommand(
    { cmd: "pnpm", args: ["--filter", "@nova/api", "--silent", "backup:restore-guard"] },
    { timeoutMs: 120_000, cwd: ctx.repoRoot },
  );
  if (res.code === 0) {
    return {
      status: "passed",
      summary: "restore target classified as local scratch (loopback, non-production)",
      evidence: res.stdoutExcerpt, // guard prints only the redacted target
    };
  }
  if (res.code === 3) {
    return {
      status: "blocked",
      summary: "restore target is NOT a local scratch database — the gate refuses to drill against it",
      blockingReasons: ["scratch restore target required (guard exit 3: non-local/production target)"],
      evidence: res.stdoutExcerpt,
    };
  }
  return { status: "failed", summary: "restore guard rejected DATABASE_URL (unparseable or guard error)", evidence: res.stderrExcerpt };
}

/** A structurally-valid but WRONG backup key for the expected-failure check.
 * Random, never a real secret. */
export function wrongBackupKey(): string {
  return randomBytes(32).toString("hex");
}
