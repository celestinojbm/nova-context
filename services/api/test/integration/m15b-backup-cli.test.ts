import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M15B (Hermes D02/D03/D06): shell-level guarantees for backup.sh /
 * restore.sh — no plaintext survives a sealing failure, no DSN credentials
 * are printed, and the target guard requires the override for non-local
 * databases. Exercised against the real scripts.
 */
const databaseUrl = process.env.DATABASE_URL;
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const BACKUP_KEY = randomBytes(32).toString("hex");

function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [join(repoRoot, "scripts", script), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const dirs: string[] = [];
const mkdir = () => {
  const d = mkdtempSync(join(tmpdir(), "m15b-bk-"));
  dirs.push(d);
  return d;
};

describe.skipIf(!databaseUrl)("M15B: backup/restore CLI hardening", () => {
  afterAll(() => {
    for (const d of dirs) execFileSync("rm", ["-rf", d]);
  });

  it("backup fails without NOVA_BACKUP_KEY and writes nothing", () => {
    const dest = mkdir();
    const { code, out } = run("backup.sh", [dest], { DATABASE_URL: databaseUrl!, NOVA_BACKUP_KEY: "" });
    expect(code).not.toBe(0);
    expect(out).toContain("NOVA_BACKUP_KEY is required");
    expect(readdirSync(dest)).toHaveLength(0);
  });

  it("successful backup outputs only .enc + manifest (no plaintext)", () => {
    const dest = mkdir();
    const { code } = run("backup.sh", [dest], {
      DATABASE_URL: databaseUrl!,
      NOVA_BACKUP_KEY: BACKUP_KEY,
    });
    expect(code).toBe(0);
    const files = readdirSync(dest);
    expect(files.some((f) => f.endsWith(".dump"))).toBe(false);
    expect(files.some((f) => f.endsWith(".tar.gz"))).toBe(false);
    expect(files.some((f) => f.endsWith(".dump.enc"))).toBe(true);
    expect(files.some((f) => f.startsWith("manifest-"))).toBe(true);
  });

  it("a sealing FAILURE leaves NO plaintext in the final dir (D02)", () => {
    const dest = mkdir();
    // A structurally-invalid backup key: pg_dump succeeds into the temp
    // workspace, then backup:seal throws — the trap wipes the workspace and
    // nothing is published to dest.
    const { code } = run("backup.sh", [dest], {
      DATABASE_URL: databaseUrl!,
      NOVA_BACKUP_KEY: "too-short-not-32-bytes",
    });
    expect(code).not.toBe(0);
    const files = readdirSync(dest);
    expect(files.some((f) => f.endsWith(".dump"))).toBe(false);
    expect(files.some((f) => f.endsWith(".tar.gz"))).toBe(false);
    expect(files.some((f) => f.endsWith(".enc"))).toBe(false); // nothing published
  });

  it("restore REDACTS the DSN and refuses a remote target without override (D03)", () => {
    const dest = mkdir();
    // A remote nova_alpha DSN with credentials — must be refused + redacted.
    const remote = "postgres://admin:sup3rs3cret@db.remote.example.com:5432/nova_alpha";
    const { code, out } = run("restore.sh", [dest, "20260101T000000Z"], {
      DATABASE_URL: remote,
      NOVA_BACKUP_KEY: BACKUP_KEY,
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(code).not.toBe(0);
    expect(out).not.toContain("sup3rs3cret");
    expect(out).not.toContain("admin:");
    expect(out).toContain("***@db.remote.example.com");
    expect(out).toMatch(/NOVA_RESTORE_ALLOW_PRODUCTION/);
  });

  it("restore never prints raw local DSN credentials either", () => {
    const dest = mkdir();
    const local = "postgres://nova:localpass@localhost:5432/nova_restore";
    // Local scratch target + override-not-needed, but no backup present →
    // it will fail at verify; the point is the DSN is never echoed raw.
    const { out } = run("restore.sh", [dest, "does-not-exist"], {
      DATABASE_URL: local,
      NOVA_BACKUP_KEY: BACKUP_KEY,
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(out).not.toContain("localpass");
    expect(out).toContain("***@localhost");
  });
});
