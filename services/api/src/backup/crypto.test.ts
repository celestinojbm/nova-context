import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDecryptable, decryptFile, encryptFile, parseBackupKey } from "./crypto.js";

/**
 * M15 (Hermes P1): authenticated encryption for backup artifacts. Proves an
 * encrypted backup is not readable as plaintext, roundtrips exactly, and a
 * wrong key / tampering fails loudly.
 */
describe("backup crypto (AES-256-GCM)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-bkcrypto-"));
  const key = parseBackupKey(randomBytes(32).toString("hex"));

  it("parseBackupKey accepts 32-byte hex/base64 and rejects the rest", () => {
    expect(parseBackupKey(randomBytes(32).toString("hex")).length).toBe(32);
    expect(parseBackupKey(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => parseBackupKey(undefined)).toThrow(/required/);
    expect(() => parseBackupKey("tooshort")).toThrow(/32 bytes/);
  });

  it("sealed artifact is not readable as plaintext and roundtrips exactly", async () => {
    const plain = join(dir, "p.bin");
    const enc = join(dir, "p.enc");
    const out = join(dir, "out.bin");
    // 300KB of recognizable data to exercise streaming + backpressure.
    const marker = Buffer.from("SENSITIVE-BACKUP-CONTENT-MARKER");
    const data = Buffer.concat([marker, randomBytes(300_000), marker]);
    writeFileSync(plain, data);

    await encryptFile(plain, enc, key);
    const sealed = readFileSync(enc);
    expect(sealed.includes(marker)).toBe(false); // no plaintext leaks
    expect(sealed.length).toBeGreaterThan(data.length); // iv+tag overhead

    await assertDecryptable(enc, key);
    await decryptFile(enc, out, key);
    expect(Buffer.compare(readFileSync(out), data)).toBe(0);
  });

  it("a wrong key fails loudly (GCM tag mismatch), never returns garbage", async () => {
    const plain = join(dir, "q.bin");
    const enc = join(dir, "q.enc");
    writeFileSync(plain, randomBytes(1024));
    await encryptFile(plain, enc, key);
    const wrong = parseBackupKey(randomBytes(32).toString("hex"));
    await expect(assertDecryptable(enc, wrong)).rejects.toThrow();
    await expect(decryptFile(enc, join(dir, "q.out"), wrong)).rejects.toThrow();
  });

  it("tampering with the ciphertext is detected", async () => {
    const plain = join(dir, "t.bin");
    const enc = join(dir, "t.enc");
    writeFileSync(plain, randomBytes(2048));
    await encryptFile(plain, enc, key);
    const bytes = readFileSync(enc);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff; // flip a ciphertext byte
    writeFileSync(enc, bytes);
    await expect(assertDecryptable(enc, key)).rejects.toThrow();
  });
});
