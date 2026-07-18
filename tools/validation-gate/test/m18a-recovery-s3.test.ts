import { describe, expect, it } from "vitest";
import { checksForMode } from "../src/config.js";
import { runGate } from "../src/runner.js";
import type { CommandResult, CommandSpec, RunContext } from "../src/types.js";

/**
 * M18A.1 finding 2 — the S3 media path wired INTO validate:recovery. Proves
 * the ordered protected checks are present for s3 stores (and absent for fs),
 * that missing/aliased s3 prerequisites BLOCK before mutation, that wrong-key
 * media verification is an expected failure (and an unexpected success FAILs),
 * and that a media-restore failure FAILs the gate. A fake runner stands in for
 * the child commands so no real S3/DB is touched.
 */

const S3_ENV = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    NOVA_MEDIA_STORE: "s3",
    NOVA_BACKUP_KEY: "b".repeat(64),
    NOVA_ENCRYPTION_KEY: "a".repeat(64),
    DATABASE_URL: "postgres://nova:nova@localhost:5432/scratch",
    NOVA_MEDIA_S3_BUCKET: "nova-scratch",
    NOVA_MEDIA_S3_ENDPOINT: "http://minio:9000",
    NOVA_BACKUP_S3_BUCKET: "nova-backup",
    NOVA_BACKUP_S3_ENDPOINT: "http://minio:9000",
    NOVA_SMOKE_INVITE: "syn-invite",
    ...over,
  }) as NodeJS.ProcessEnv;

const RECOVERY_FLAGS = {
  "backup-dir": "/secure/backups",
  stamp: "20260717T000000Z",
  "restored-base-url": "http://127.0.0.1:3999",
};

/** Fake runner: expected-failure commands "fail" (non-zero) by default so the
 * expected-failure checks pass; the scratch guard passes (exit 0). `override`
 * lets a test force a specific command's exit code. */
function fakeRunner(override: (cmd: string, spec: CommandSpec) => number | undefined = () => undefined) {
  const ran: string[] = [];
  const runner = async (spec: CommandSpec): Promise<CommandResult> => {
    const line = [spec.cmd, ...spec.args].join(" ");
    ran.push(line);
    const forced = override(line, spec);
    const code = forced !== undefined ? forced : spec.expectFailure ? 2 : 0;
    return { code, timedOut: false, durationMs: 3, stdoutExcerpt: "ok", stderrExcerpt: "" };
  };
  return { runner, ran };
}

function ctxFor(
  env: NodeJS.ProcessEnv,
  override?: (cmd: string, spec: CommandSpec) => number | undefined,
) {
  const { runner, ran } = fakeRunner(override);
  const ctx: RunContext = {
    repoRoot: process.cwd(),
    mode: "recovery",
    flags: { ...RECOVERY_FLAGS },
    env,
    runCommand: runner,
    runtime: { extraSecrets: [] },
  };
  return { ctx, ran };
}

async function recovery(
  env: NodeJS.ProcessEnv,
  override?: (cmd: string, spec: CommandSpec) => number | undefined,
) {
  const { ctx, ran } = ctxFor(env, override);
  const report = await runGate({ mode: "recovery", ctx, checks: checksForMode("recovery", ctx) });
  return { report, ran };
}

describe("M18A.1 finding 2: S3 media recovery gate", () => {
  it("s3 mode inserts the media checks in order, all required + protected", async () => {
    const specs = checksForMode("recovery", ctxFor(S3_ENV()).ctx);
    const ids = specs.map((s) => s.id);
    // Ordered protected sequence.
    expect(ids).toEqual([
      "recovery_prerequisites",
      "s3_recovery_prerequisites",
      "scratch_guard",
      "backup_verify",
      "backup_verify_wrong_key",
      "media_backup_verify",
      "media_backup_verify_wrong_key",
      "restore_scratch",
      "post_restore_migrate",
      "media_restore_s3",
      "media_verify",
      "post_restore_smoke",
    ]);
    for (const id of ["media_backup_verify", "media_backup_verify_wrong_key", "media_restore_s3"]) {
      const s = specs.find((x) => x.id === id)!;
      expect(s.required).toBe(true);
      expect(["backup", "media", "recovery"]).toContain(s.category);
    }
  });

  it("fs mode keeps the tar path — no s3 media checks", async () => {
    const specs = checksForMode("recovery", ctxFor({ NOVA_MEDIA_STORE: "fs" } as NodeJS.ProcessEnv).ctx);
    const ids = specs.map((s) => s.id);
    expect(ids).not.toContain("s3_recovery_prerequisites");
    expect(ids).not.toContain("media_backup_verify");
    expect(ids).not.toContain("media_restore_s3");
  });

  it("full s3 recovery sequence (fake commands) → PASS, media verify + restore both ran", async () => {
    const { report, ran } = await recovery(S3_ENV());
    expect(report.outcome).toBe("PASS");
    expect(ran.some((c) => c.includes("media:verify-backup-s3"))).toBe(true);
    expect(ran.some((c) => c.includes("media:restore-s3") && c.includes("--apply"))).toBe(true);
    expect(ran.some((c) => c.includes("media:verify") && !c.includes("backup"))).toBe(true);
  });

  it("missing NOVA_BACKUP_S3_BUCKET → BLOCKED before any mutation (nothing ran past prereqs)", async () => {
    const env = S3_ENV();
    delete env.NOVA_BACKUP_S3_BUCKET;
    const { report, ran } = await recovery(env);
    expect(report.outcome).toBe("BLOCKED");
    expect(report.checks.find((c) => c.id === "s3_recovery_prerequisites")!.status).toBe("blocked");
    // scratch guard + all command mutations cascade-skipped.
    expect(ran).toHaveLength(0);
  });

  it("scratch media store aliased with the backup store → BLOCKED", async () => {
    const { report } = await recovery(S3_ENV({ NOVA_MEDIA_S3_BUCKET: "nova-backup" }));
    expect(report.outcome).toBe("BLOCKED");
    expect(report.checks.find((c) => c.id === "s3_recovery_prerequisites")!.status).toBe("blocked");
    expect(report.blocking_reasons.join(" ")).toContain("SAME store");
  });

  it("NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes → BLOCKED before any mutation (a drill must never overwrite primary) (M18A.1 review #4)", async () => {
    const { report, ran } = await recovery(S3_ENV({ NOVA_MEDIA_RESTORE_ALLOW_PRIMARY: "yes" }));
    expect(report.outcome).toBe("BLOCKED");
    expect(report.checks.find((c) => c.id === "s3_recovery_prerequisites")!.status).toBe("blocked");
    expect(report.blocking_reasons.join(" ")).toContain("NOVA_MEDIA_RESTORE_ALLOW_PRIMARY");
    expect(ran).toHaveLength(0); // nothing mutating ran
  });

  it("scratch guard BLOCKED (exit 3: unauthorized remote) → BLOCKED, no restore spawned (M18A.2 §1)", async () => {
    const { report, ran } = await recovery(S3_ENV(), (cmd) =>
      cmd.includes("backup:scratch-guard") ? 3 : undefined,
    );
    expect(report.outcome).toBe("BLOCKED");
    expect(report.checks.find((c) => c.id === "scratch_guard")!.status).toBe("blocked");
    expect(ran.some((c) => c.includes("media:restore-s3"))).toBe(false);
    expect(ran.some((c) => c.includes("restore.sh") || c.includes("restore-scratch"))).toBe(false);
  });

  it("scratch guard ERROR (exit 2: malformed DATABASE_URL) → FAIL, no restore spawned (M18A.2 §1)", async () => {
    const { report, ran } = await recovery(S3_ENV(), (cmd) =>
      cmd.includes("backup:scratch-guard") ? 2 : undefined,
    );
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "scratch_guard")!.status).toBe("failed");
    expect(ran.some((c) => c.includes("media:restore-s3"))).toBe(false);
  });

  it("wrong media backup key that UNEXPECTEDLY succeeds → FAIL", async () => {
    // Force the expected-failure media wrong-key check to exit 0 (success).
    const { report } = await recovery(S3_ENV(), (_cmd, spec) =>
      spec.expectFailure && spec.args.includes("media:verify-backup-s3") ? 0 : undefined,
    );
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "media_backup_verify_wrong_key")!.status).toBe("failed");
  });

  it("media inventory verification failure → FAIL", async () => {
    const { report } = await recovery(S3_ENV(), (cmd, spec) =>
      cmd.includes("media:verify-backup-s3") && !spec.expectFailure ? 2 : undefined,
    );
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "media_backup_verify")!.status).toBe("failed");
  });

  it("media restore failure → FAIL (recovery cannot PASS without a successful media restore)", async () => {
    const { report } = await recovery(S3_ENV(), (cmd) => (cmd.includes("media:restore-s3") ? 1 : undefined));
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "media_restore_s3")!.status).toBe("failed");
  });
});
