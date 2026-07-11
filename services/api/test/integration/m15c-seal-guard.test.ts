import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M15C (Hermes M15B-R02): `backup:seal` must refuse the unsafe in-place mode
 * where plaintext and sealed artifacts share a directory. The old `--dir`
 * alias (and the `out = work` default) allowed exactly that, defeating the
 * D02 no-plaintext-survives guarantee for any caller invoking the tool
 * directly. These exercise the real CLI (no DB required).
 */
const apiRoot = join(import.meta.dirname, "..", "..");
const BACKUP_KEY = randomBytes(32).toString("hex");
const dirs: string[] = [];
const mkdir = () => {
  const d = mkdtempSync(join(tmpdir(), "m15c-seal-"));
  dirs.push(d);
  return d;
};

function seal(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("pnpm", ["exec", "tsx", "src/backup/run-seal.ts", ...args], {
      cwd: apiRoot,
      encoding: "utf8",
      env: { ...process.env, NOVA_BACKUP_KEY: BACKUP_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("M15C: backup:seal rejects unsafe in-place mode (R02)", () => {
  afterAll(() => {
    for (const d of dirs) execFileSync("rm", ["-rf", d]);
  });

  it("rejects the legacy --dir alias (in-place sealing)", () => {
    const dir = mkdir();
    const { code, out } = seal([`--dir=${dir}`, "--stamp=20260101T000000Z"]);
    expect(code).not.toBe(0);
    expect(out).toContain("--dir");
  });

  it("rejects --work === --out (plaintext and sealed in one dir)", () => {
    const dir = mkdir();
    const { code, out } = seal([`--work=${dir}`, `--out=${dir}`, "--stamp=20260101T000000Z"]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/work === --out|must never share/i);
  });

  // M16 (Hermes M15C accepted-P2 hardening): a symlinked --out pointing at
  // --work is a different spelling of the SAME physical directory; the
  // realpath() comparison must still reject it (a lexical check would not).
  it("rejects a symlinked --out that resolves to --work (realpath hardening)", () => {
    const work = mkdir();
    const link = join(mkdtempSync(join(tmpdir(), "m15c-seal-")), "out-link");
    dirs.push(link);
    symlinkSync(work, link); // link → work (same physical dir)
    const { code, out } = seal([`--work=${work}`, `--out=${link}`, "--stamp=20260101T000000Z"]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/work === --out|must never share|physical path/i);
  });
});
