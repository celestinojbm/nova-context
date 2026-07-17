import { randomBytes } from "node:crypto";
import { canonicalizeEndpoint, fingerprintIdentity, s3Identity } from "@nova/context-engine/object-store";
import type { CheckOutcome, RunContext } from "../types.js";

/**
 * Recovery-drill checks (M17B §3D). Prepared in M17B; a real drill runs only
 * when the operator supplies a sealed backup and a SAFE SCRATCH target and
 * separately authorizes it. Never restores over production: the existing
 * backup:restore-guard (loopback-host + non-production classification,
 * M15-D03) is the arbiter, and the raw DATABASE_URL is never printed.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export async function recoveryPrerequisites(ctx: RunContext): Promise<CheckOutcome> {
  const reasons: string[] = [];
  if (!ctx.flags["backup-dir"]) reasons.push("missing --backup-dir (no sealed backup to drill against)");
  if (!ctx.flags.stamp) reasons.push("missing --stamp (which backup set to verify/restore)");
  if (!ctx.env.NOVA_BACKUP_KEY) reasons.push("missing env: NOVA_BACKUP_KEY (cannot unseal)");
  if (!ctx.env.DATABASE_URL) reasons.push("missing env: DATABASE_URL (no scratch restore target)");
  if (!ctx.env.NOVA_ENCRYPTION_KEY) {
    reasons.push("missing env: NOVA_ENCRYPTION_KEY (media:verify after restore needs the data key)");
  }
  // Phase A correction: the post-restore synthetic smoke needs an invite to
  // create its self-deleting synthetic account. Missing invite is an honest
  // prerequisite BLOCKED (named only, value never printed) — not a smoke
  // FAIL. Accepted via --invite or NOVA_SMOKE_INVITE.
  if (!ctx.flags.invite && !ctx.env.NOVA_SMOKE_INVITE) {
    reasons.push(
      "missing synthetic invite (--invite or NOVA_SMOKE_INVITE) for the mandatory post-restore smoke account",
    );
  }
  // M17B.1 finding 1: a complete recovery PASS includes post-restore
  // synthetic smoke against the RESTORED stack, so its URL is a hard
  // prerequisite — a drill that never exercises the restored system
  // functionally must be BLOCKED, not PASS.
  const restored = ctx.flags["restored-base-url"];
  if (!restored) {
    reasons.push(
      "missing --restored-base-url (post-restore synthetic smoke against the restored scratch stack is mandatory for a recovery PASS)",
    );
  } else if (!/^https?:\/\//.test(restored)) {
    return { status: "failed", summary: "--restored-base-url must be an http(s) URL" };
  } else {
    // The restored stack should be the local scratch deployment. A
    // non-loopback URL needs an explicit operator acknowledgment — the gate
    // must never smoke (or restore toward) something production-shaped.
    let host = "";
    try {
      host = new URL(restored).hostname;
    } catch {
      return { status: "failed", summary: "--restored-base-url is not a parseable URL" };
    }
    if (!LOOPBACK_HOSTS.has(host) && ctx.env.NOVA_VALIDATE_ALLOW_REMOTE_RESTORED !== "yes") {
      reasons.push(
        "restored-base-url is not loopback; set NOVA_VALIDATE_ALLOW_REMOTE_RESTORED=yes ONLY for an explicitly authorized scratch host",
      );
    }
  }
  if (reasons.length) {
    return {
      status: "blocked",
      summary: "safe scratch recovery prerequisites unavailable",
      blockingReasons: reasons,
    };
  }
  return {
    status: "passed",
    summary: "backup set, keys, scratch target, and restored-stack URL configured (values not inspected)",
  };
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

/** Is the media store s3-backed? Recovery inserts the S3 media path only then;
 * fs mode keeps the tar-based path. */
export function isS3Media(env: NodeJS.ProcessEnv): boolean {
  return (env.NOVA_MEDIA_STORE ?? "fs") === "s3";
}

/**
 * M18A.1 finding 2: S3 media recovery prerequisites. The recovery job restores
 * media into the CONFIGURED (scratch) store (NOVA_MEDIA_S3_*) from the backup
 * store (NOVA_BACKUP_S3_*). Both must exist, and — critically — the scratch
 * media destination must be a DIFFERENT physical store from the backup store,
 * so a restore can never overwrite the backup it reads from. (Separation from
 * the ORIGINAL PRIMARY is enforced inside media:restore-s3 via the inventory's
 * source_fingerprint, which is unknown until the inventory is read.)
 * Missing/aliased config is a safe-prerequisite BLOCKED — before any mutation.
 */
export async function s3RecoveryPrerequisites(ctx: RunContext): Promise<CheckOutcome> {
  if (!isS3Media(ctx.env)) {
    return {
      status: "skipped",
      skipReason: "not_applicable",
      summary: "fs media mode — s3 media recovery checks not applicable (tar path used)",
    };
  }
  const reasons: string[] = [];
  if (!ctx.env.NOVA_BACKUP_S3_BUCKET) reasons.push("missing env: NOVA_BACKUP_S3_BUCKET (media backup store to restore FROM)");
  if (!ctx.env.NOVA_MEDIA_S3_BUCKET) reasons.push("missing env: NOVA_MEDIA_S3_BUCKET (scratch media destination to restore INTO)");
  if (
    ctx.env.NOVA_BACKUP_S3_BUCKET &&
    ctx.env.NOVA_MEDIA_S3_BUCKET
  ) {
    const scratch = fingerprintIdentity(
      s3Identity(canonicalizeEndpoint(ctx.env.NOVA_MEDIA_S3_ENDPOINT), ctx.env.NOVA_MEDIA_S3_BUCKET),
    );
    const backup = fingerprintIdentity(
      s3Identity(
        canonicalizeEndpoint(ctx.env.NOVA_BACKUP_S3_ENDPOINT ?? ctx.env.NOVA_MEDIA_S3_ENDPOINT),
        ctx.env.NOVA_BACKUP_S3_BUCKET,
      ),
    );
    if (scratch === backup) {
      reasons.push(
        "scratch media store (NOVA_MEDIA_S3_*) resolves to the SAME store as the backup (NOVA_BACKUP_S3_*) — they must be physically separate",
      );
    }
  }
  if (reasons.length) {
    return {
      status: "blocked",
      summary: "s3 media recovery prerequisites unavailable (values not inspected)",
      blockingReasons: reasons,
    };
  }
  return {
    status: "passed",
    summary: "s3 media backup store + a SEPARATE scratch media destination configured",
  };
}
