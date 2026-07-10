import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encryptFile, parseBackupKey } from "./crypto.js";
import { buildManifest, manifestPath, verifyBackup, writeManifest } from "./manifest.js";

/**
 * M15 (Hermes P1): the backup manifest lets an operator verify integrity —
 * with the key (decryptable) or without (sha256 of the sealed bytes). Proves
 * a good backup verifies and any tampering is caught.
 */
describe("backup manifest + verify", () => {
  const key = parseBackupKey(randomBytes(32).toString("hex"));

  async function makeSealedBackup(): Promise<{ dir: string; stamp: string }> {
    const dir = mkdtempSync(join(tmpdir(), "nova-manifest-"));
    const stamp = "20260101T000000Z";
    // Two plaintext "artifacts" → seal them → build+write manifest.
    const dbPlain = join(dir, `nova-db-${stamp}.dump`);
    const mediaPlain = join(dir, `nova-media-${stamp}.tar.gz`);
    writeFileSync(dbPlain, randomBytes(4096));
    writeFileSync(mediaPlain, randomBytes(2048));
    await encryptFile(dbPlain, `${dbPlain}.enc`, key);
    await encryptFile(mediaPlain, `${mediaPlain}.enc`, key);
    const manifest = await buildManifest(dir, stamp, "2026-01-01T00:00:00Z", [
      { name: `nova-db-${stamp}.dump.enc`, role: "postgres" },
      { name: `nova-media-${stamp}.tar.gz.enc`, role: "media" },
    ]);
    await writeManifest(dir, manifest);
    return { dir, stamp };
  }

  it("verifies a good backup — hash-only and with the key", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const hashOnly = await verifyBackup(dir, stamp, null);
    expect(hashOnly.ok).toBe(true);
    expect(hashOnly.checks.every((c) => c.hash === "ok")).toBe(true);

    const withKey = await verifyBackup(dir, stamp, key);
    expect(withKey.ok).toBe(true);
    expect(withKey.checks.every((c) => c.hash === "ok" && c.decrypt === "ok")).toBe(true);
  });

  it("catches tampering via the manifest hash (no key needed)", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const enc = join(dir, `nova-db-${stamp}.dump.enc`);
    const bytes = readFileSync(enc);
    bytes[10] ^= 0xff;
    writeFileSync(enc, bytes);
    const result = await verifyBackup(dir, stamp, null);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.artifact.includes("db"))!.hash).toBe("mismatch");
  });

  it("catches a wrong key at the decrypt check", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const wrong = parseBackupKey(randomBytes(32).toString("hex"));
    const result = await verifyBackup(dir, stamp, wrong);
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.decrypt === "fail")).toBe(true);
  });

  it("manifest carries no key material", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const raw = readFileSync(manifestPath(dir, stamp), "utf8");
    expect(raw).not.toContain(key.toString("hex"));
    expect(raw).not.toContain(key.toString("base64"));
  });
});
