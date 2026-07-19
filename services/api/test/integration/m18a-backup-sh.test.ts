import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M18A.1 finding 1 — scripts/backup.sh is FAIL-CLOSED for s3 media stores and
 * distinguishes db-only failure from a complete db+media backup. Requires a
 * reachable Postgres (DATABASE_URL) with pg_dump on PATH; skips otherwise.
 */
const execFileAsync = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

async function runBackup(env: Record<string, string>, dest: string) {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["scripts/backup.sh", dest], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe.skipIf(!databaseUrl)("M18A.1: scripts/backup.sh fail-closed media handling", () => {
  const dirs: string[] = [];
  const dest = () => {
    const d = mkdtempSync(join(tmpdir(), "nova-bk-"));
    dirs.push(d);
    return join(d, "out");
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("s3 media store WITHOUT NOVA_BACKUP_S3_BUCKET → exits non-zero, never prints 'Backup complete'", async () => {
    const { code, out } = await runBackup(
      {
        NOVA_BACKUP_KEY: randomBytes(32).toString("hex"),
        DATABASE_URL: databaseUrl!,
        NOVA_MEDIA_STORE: "s3",
        NOVA_MEDIA_FS_ROOT: "",
      },
      dest(),
    );
    expect(code).not.toBe(0);
    expect(out).not.toContain("Backup complete");
    expect(out).toContain("NOVA_BACKUP_S3_BUCKET is not set");
  }, 60_000);

  it("s3 store STILL refuses (no db-only backup) even when NOVA_MEDIA_FS_ROOT is set to a real dir", async () => {
    // Regression (M18A.1 review): the fs branch must NOT shadow the s3
    // fail-closed guard. NOVA_MEDIA_FS_ROOT has a default and is often present.
    const fsRoot = mkdtempSync(join(tmpdir(), "nova-fsroot-"));
    dirs.push(fsRoot);
    const { code, out } = await runBackup(
      {
        NOVA_BACKUP_KEY: randomBytes(32).toString("hex"),
        DATABASE_URL: databaseUrl!,
        NOVA_MEDIA_STORE: "s3",
        NOVA_MEDIA_FS_ROOT: fsRoot, // exists — would wrongly win under the old order
      },
      dest(),
    );
    expect(code).not.toBe(0);
    expect(out).not.toContain("Backup complete");
    expect(out).toContain("NOVA_BACKUP_S3_BUCKET is not set");
    expect(out).not.toContain("Media store tar"); // fs branch was NOT taken
  }, 60_000);

  it("fs db-only, publish off → 'Local sealed backup prepared' + 'Local-only backup complete' (NOT durable off-box) (M18A.3 §4)", async () => {
    const { code, out } = await runBackup(
      {
        NOVA_BACKUP_KEY: randomBytes(32).toString("hex"),
        DATABASE_URL: databaseUrl!,
        NOVA_MEDIA_STORE: "fs",
        NOVA_MEDIA_FS_ROOT: "",
      },
      dest(),
    );
    expect(code).toBe(0);
    expect(out).toContain("Local sealed backup prepared");
    expect(out).toContain("no media present");
    // Off-box publishing disabled → durability is NOT claimed.
    expect(out).toContain("Local-only backup complete; off-box durability not established");
    expect(out).not.toContain("durable off-box:"); // the durable-completion line
  }, 60_000);

  it("fs db-only + NOVA_BACKUP_REQUIRE_OFFBOX=yes but publish off → fails closed, no completion (M18A.3 §4)", async () => {
    const { code, out } = await runBackup(
      {
        NOVA_BACKUP_KEY: randomBytes(32).toString("hex"),
        DATABASE_URL: databaseUrl!,
        NOVA_MEDIA_STORE: "fs",
        NOVA_MEDIA_FS_ROOT: "",
        NOVA_BACKUP_REQUIRE_OFFBOX: "yes",
      },
      dest(),
    );
    expect(code).not.toBe(0);
    expect(out).toContain("NOVA_BACKUP_REQUIRE_OFFBOX=yes but off-box publish is not enabled");
    expect(out).not.toContain("backup complete"); // no completion statement at all
  }, 60_000);
});
