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

  it("fs store with no media root → completes as db-only (distinct 'no media present' message)", async () => {
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
    expect(out).toContain("Backup complete");
    expect(out).toContain("no media present");
  }, 60_000);
});
