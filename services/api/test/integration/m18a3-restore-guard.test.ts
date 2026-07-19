import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M18A.3 §1 — scripts/restore.sh uses ONE authorization decision. In
 * authorized-scratch mode it invokes `backup:scratch-guard` (the same guard the
 * gate validated) and the production override is inaccessible; a refused target
 * never reaches pg_restore and no raw DSN is printed. Requires pg_dump/pnpm on
 * PATH via the workspace; the guard runs BEFORE any DB access so no real backup
 * or database is needed. Skips if DATABASE_URL is unset (env not wired).
 */
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const dirs: string[] = [];
const SECRET_PW = "s3cr3t-restore-pw-zzz";

function dest(): string {
  const d = mkdtempSync(join(tmpdir(), "nova-restore-"));
  dirs.push(d);
  return d;
}

async function runRestore(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      ["scripts/restore.sh", dest(), "20260101T000000Z"],
      { cwd: repoRoot, env: { ...process.env, ...env }, timeout: 60_000 },
    );
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe("M18A.3 §1: restore.sh authorized-scratch guard", () => {
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const KEY = () => randomBytes(32).toString("hex");

  it("authorized-scratch + remote target WITHOUT the envelope → refused before pg_restore, no raw DSN", async () => {
    const { code, out } = await runRestore({
      NOVA_BACKUP_KEY: KEY(),
      DATABASE_URL: `postgresql://nova:${SECRET_PW}@render-pg.internal:5432/nova_scratch`,
      NOVA_RESTORE_MODE: "authorized-scratch",
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("backup:scratch-guard refused");
    expect(out).not.toContain("restoring Postgres"); // never reached pg_restore
    expect(out).not.toContain(SECRET_PW); // raw DSN/credential never printed
    expect(out).not.toContain("nova:s3cr3t");
  }, 90_000);

  it("authorized-scratch + NOVA_RESTORE_ALLOW_PRODUCTION=yes → forbidden (override inaccessible)", async () => {
    const { code, out } = await runRestore({
      NOVA_BACKUP_KEY: KEY(),
      DATABASE_URL: `postgresql://nova:${SECRET_PW}@render-pg.internal:5432/nova_scratch`,
      NOVA_RESTORE_MODE: "authorized-scratch",
      NOVA_RESTORE_ALLOW_PRODUCTION: "yes",
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("forbidden in authorized-scratch mode");
    expect(out).not.toContain("restoring Postgres");
    expect(out).not.toContain(SECRET_PW);
  }, 90_000);

  it("authorized-scratch + loopback scratch → guard PASSES (proceeds past the guard to backup:verify)", async () => {
    const { code, out } = await runRestore({
      NOVA_BACKUP_KEY: KEY(),
      DATABASE_URL: "postgresql://nova:nova@localhost:5432/nova_scratch",
      NOVA_RESTORE_MODE: "authorized-scratch",
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    // The guard passes (local loopback scratch); the run then fails later on the
    // missing/empty backup dir — proving it got PAST the target guard.
    expect(out).not.toContain("backup:scratch-guard refused");
    expect(out).toContain("verifying backup");
    expect(code).not.toBe(0); // no real backup present → fails at verify, not the guard
  }, 90_000);

  it("authorized-scratch + fully-authorized remote envelope → guard PASSES", async () => {
    // Build the exact envelope for a remote target using the guard's own
    // fingerprint command so the values match.
    const dsn = "postgresql://nova:pw@render-pg.internal:5432/nova_scratch_run7";
    const { stdout: fp } = await execFileAsync(
      "pnpm",
      ["--filter", "@nova/api", "--silent", "backup:scratch-guard", "--", "--fingerprint"],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: dsn } },
    );
    const fingerprint = fp.trim();
    const primaryFp = randomBytes(32).toString("hex");
    const { out } = await runRestore({
      NOVA_BACKUP_KEY: KEY(),
      DATABASE_URL: dsn,
      NODE_ENV: "production", // production runtime is allowed for a managed scratch
      NOVA_RESTORE_MODE: "authorized-scratch",
      NOVA_RESTORE_CONFIRM: "RESTORE",
      NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH: "yes",
      NOVA_RESTORE_TARGET_CLASS: "scratch",
      NOVA_RESTORE_SCRATCH_CONFIRM: "RESTORE-TO-SCRATCH",
      NOVA_RESTORE_EXPECT_HOST: "render-pg.internal",
      NOVA_RESTORE_EXPECT_DATABASE: "nova_scratch_run7",
      NOVA_RESTORE_EXPECT_FINGERPRINT: fingerprint,
      NOVA_PRIMARY_DATABASE_FINGERPRINT: primaryFp,
      NOVA_RECOVERY_RUN_ID: "run7",
    });
    // Envelope matches → guard passes; the run then fails later on the missing
    // backup — proving the same envelope the gate validated also authorizes the
    // destructive restore-script guard.
    expect(out).not.toContain("backup:scratch-guard refused");
    expect(out).toContain("verifying backup");
  }, 90_000);

  it("manual mode (default) still requires the production override for a remote target", async () => {
    const { code, out } = await runRestore({
      NOVA_BACKUP_KEY: KEY(),
      DATABASE_URL: `postgresql://nova:${SECRET_PW}@db.example.com:5432/nova`,
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("not a local scratch database");
    expect(out).not.toContain("restoring Postgres");
    expect(out).not.toContain(SECRET_PW);
  }, 90_000);
});
