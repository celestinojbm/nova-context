import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { encryptFile, parseBackupKey } from "../../src/backup/crypto.js";

/**
 * M18A.3 §6 — backup:unseal-file is the single unseal primitive scripts/
 * restore.sh calls (replacing the fragile inline `tsx -e` eval). It MUST:
 *   - decrypt a sealed artifact with the correct key (happy path);
 *   - fail CLOSED (exit 2) on a wrong key without leaving usable plaintext;
 *   - never print the key or raw secret material in its error.
 */
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const dirs: string[] = [];

function work(): string {
  const d = mkdtempSync(join(tmpdir(), "nova-unseal-"));
  dirs.push(d);
  return d;
}
async function runUnseal(inPath: string, outPath: string, backupKey: string) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      ["--filter", "@nova/api", "--silent", "backup:unseal-file", "--", `--in=${inPath}`, `--out=${outPath}`],
      { cwd: repoRoot, env: { ...process.env, NOVA_BACKUP_KEY: backupKey }, timeout: 60_000 },
    );
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe("M18A.3 §6: backup:unseal-file", () => {
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("decrypts a sealed artifact with the correct key", async () => {
    const dir = work();
    const keyHex = randomBytes(32).toString("hex");
    const plain = join(dir, "plain.bin");
    const sealed = join(dir, "sealed.enc");
    const out = join(dir, "out.bin");
    const payload = randomBytes(4096);
    writeFileSync(plain, payload);
    await encryptFile(plain, sealed, parseBackupKey(keyHex));

    const { code, out: log } = await runUnseal(sealed, out, keyHex);
    expect(code).toBe(0);
    expect(log).toContain("UNSEAL OK");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).equals(payload)).toBe(true);
  }, 90_000);

  it("fails closed (exit 2) on a wrong key with no usable plaintext and no key leak", async () => {
    const dir = work();
    const realKey = randomBytes(32).toString("hex");
    const wrongKey = randomBytes(32).toString("hex");
    const plain = join(dir, "plain.bin");
    const sealed = join(dir, "sealed.enc");
    const out = join(dir, "out.bin");
    const payload = randomBytes(4096);
    writeFileSync(plain, payload);
    await encryptFile(plain, sealed, parseBackupKey(realKey));

    const { code, out: log } = await runUnseal(sealed, out, wrongKey);
    expect(code).toBe(2); // decryption/auth failure → fail closed
    expect(log).not.toContain("UNSEAL OK");
    // The wrong key must never appear in the error output.
    expect(log).not.toContain(wrongKey);
    expect(log).not.toContain(realKey);
    // No usable plaintext: either the file was never finalized or it does not
    // equal the real payload (GCM auth failure aborts before a full write).
    if (existsSync(out)) {
      expect(readFileSync(out).equals(payload)).toBe(false);
    }
  }, 90_000);
});
