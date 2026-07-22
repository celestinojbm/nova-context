import { randomBytes } from "node:crypto";
import type { CheckOutcome, RunContext } from "../types.js";

// NOTE: object-store identity helpers are imported LAZILY inside
// s3RecoveryPrerequisites (see below), never at module top level. The gate CLI
// builds the repo as its FIRST check (`pnpm build`), so `@nova/context-engine`'s
// compiled `dist/object-store.js` does not exist when the CLI first loads in a
// clean checkout. A static import here would crash the CLI at startup — before
// the build check runs — in EVERY mode (config.ts loads every check module),
// not just recovery. A dynamic import defers the resolution to the point the
// check actually executes, matching the pattern in cli.ts.

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

/** The scratch target must classify as a SAFE scratch database via
 * `backup:scratch-guard` (M18A.2): either LOCAL SCRATCH (loopback + non-prod)
 * or an EXPLICITLY-AUTHORIZED REMOTE SCRATCH (every NOVA_RESTORE_* condition
 * satisfied — host/db/fingerprint match, run-id marker, proven distinct from
 * the primary, typed confirmation). Anything else is a missing safe
 * prerequisite (BLOCKED); a malformed DATABASE_URL is a guard error (FAILED).
 * The gate never drives a production or unverified restore, and the guard
 * prints only a credential-free target + names-only reasons. */
export async function scratchTargetGuard(ctx: RunContext): Promise<CheckOutcome> {
  const res = await ctx.runCommand(
    { cmd: "pnpm", args: ["--filter", "@nova/api", "--silent", "backup:scratch-guard"] },
    { timeoutMs: 120_000, cwd: ctx.repoRoot },
  );
  if (res.code === 0) {
    return {
      status: "passed",
      summary: "restore target classified as safe scratch (local loopback OR explicitly-authorized remote scratch)",
      evidence: res.stdoutExcerpt, // guard prints only the redacted target + reasons
    };
  }
  if (res.code === 3) {
    return {
      status: "blocked",
      summary: "restore target is NOT an authorized scratch database — the gate refuses to drill against it",
      blockingReasons: ["safe scratch target required (guard exit 3: unauthorized remote / mismatch / primary-equal / production)"],
      evidence: res.stdoutExcerpt,
    };
  }
  return { status: "failed", summary: "scratch guard rejected DATABASE_URL (missing or malformed)", evidence: res.stderrExcerpt };
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
 * so a restore can never overwrite the backup it reads from.
 *
 * Separation from the ORIGINAL PRIMARY is a defense-in-depth RUNTIME guard
 * inside media:restore-s3 (it refuses when the destination fingerprint matches
 * the inventory's source_fingerprint, which is unknown until the inventory is
 * read) — NOT a by-construction gate check. Two hardenings make that guard
 * trustworthy from the gate (M18A.1 review):
 *   - endpoint aliasing can no longer evade the fingerprint match: AWS-endpoint
 *     spellings all canonicalize to one token (canonicalizeEndpoint);
 *   - the restore-over-primary escape hatch (NOVA_MEDIA_RESTORE_ALLOW_PRIMARY)
 *     is REFUSED here — a drill must always target scratch, never primary.
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
  // A recovery DRILL must ALWAYS restore into scratch, NEVER over the original
  // primary. NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes disables media:restore-s3's
  // restore-over-primary refusal; it exists ONLY for a deliberate manual
  // disaster recovery, never for the automated gate. If set, BLOCK before any
  // mutation rather than run a drill that could overwrite live primary media.
  if ((ctx.env.NOVA_MEDIA_RESTORE_ALLOW_PRIMARY ?? "").toLowerCase() === "yes") {
    reasons.push(
      "NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes disables the restore-over-primary guard — a recovery drill must never enable it (unset it; it is only for manual disaster recovery)",
    );
  }
  if (
    ctx.env.NOVA_BACKUP_S3_BUCKET &&
    ctx.env.NOVA_MEDIA_S3_BUCKET
  ) {
    // Lazy import: the compiled dist is present by the time this check runs
    // (build ran first), but must not be required at CLI load time.
    const { canonicalizeEndpoint, fingerprintIdentity, s3Identity } = await import(
      "@nova/context-engine/object-store"
    );
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
