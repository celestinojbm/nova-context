import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M16 (Hermes M15C accepted-P3): additional restore-CLI guard coverage,
 * exercised against the real scripts/restore.sh. Complements
 * m15b-backup-cli.test.ts (which already covers remote-target refusal + DSN
 * redaction). Here: missing backup key, missing typed confirmation, and a
 * wrong-key verify failure that stops BEFORE the database is touched.
 */
const databaseUrl = process.env.DATABASE_URL;
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const dirs: string[] = [];
const mkdir = () => {
  const d = mkdtempSync(join(tmpdir(), "m16-restore-"));
  dirs.push(d);
  return d;
};

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

afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});

// These guard checks fire before any DB connection, so they need no Postgres.
describe("M16: restore.sh guards (no DB required)", () => {
  const LOCAL_DSN = "postgres://nova:localsecret@localhost:5432/nova_restore";

  it("refuses to run without NOVA_BACKUP_KEY", () => {
    const { code, out } = run("restore.sh", [mkdir(), "20260101T000000Z"], {
      DATABASE_URL: LOCAL_DSN,
      NOVA_BACKUP_KEY: "",
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("NOVA_BACKUP_KEY is required");
    // Even on this early exit the raw DSN password never appears.
    expect(out).not.toContain("localsecret");
  });

  it("does not proceed on a local restore when the typed confirmation is absent", () => {
    // Local loopback target → guard passes; with stdin closed and no
    // NOVA_RESTORE_CONFIRM, the confirmation prompt cannot be satisfied, so
    // the script fails closed (the EOF on `read` exits under `set -e`) BEFORE
    // it ever verifies or touches the database.
    const { code, out } = run("restore.sh", [mkdir(), "20260101T000000Z"], {
      DATABASE_URL: LOCAL_DSN,
      NOVA_BACKUP_KEY: randomBytes(32).toString("hex"),
    });
    expect(code).not.toBe(0);
    // It stopped at the confirmation gate — never reached verify/restore.
    expect(out).toContain("Type RESTORE to proceed");
    expect(out).not.toMatch(/verifying backup/i);
    expect(out).not.toContain("pg_restore --clean");
    // The target line is redacted; the password is never printed.
    expect(out).not.toContain("localsecret");
    expect(out).toContain("***@localhost");
  });
});

// Wrong-key restore must fail at backup:verify (manifest MAC + decrypt) BEFORE
// pg_restore touches the database. Needs a real sealed backup, so DB-gated.
describe.skipIf(!databaseUrl)("M16: wrong-key restore fails before touching the DB", () => {
  it("verify fails and nothing is restored", () => {
    const dest = mkdir();
    const keyA = randomBytes(32).toString("hex");
    const keyB = randomBytes(32).toString("hex");

    const backup = run("backup.sh", [dest], { DATABASE_URL: databaseUrl!, NOVA_BACKUP_KEY: keyA });
    expect(backup.code).toBe(0);
    const enc = readdirSync(dest).find((f) => /^nova-db-.*\.dump\.enc$/.test(f));
    expect(enc).toBeTruthy();
    const stamp = enc!.replace(/^nova-db-/, "").replace(/\.dump\.enc$/, "");

    // Restore into a LOCAL scratch target with the WRONG key.
    const restore = run("restore.sh", [dest, stamp], {
      DATABASE_URL: "postgres://nova:nova@localhost:5432/nova_scratch_m16",
      NOVA_BACKUP_KEY: keyB,
      NOVA_RESTORE_CONFIRM: "RESTORE",
    });
    expect(restore.code).not.toBe(0);
    // It stopped at verification, before any pg_restore step.
    expect(restore.out).toMatch(/verif/i);
    expect(restore.out).not.toContain("pg_restore --clean");
  });
});
