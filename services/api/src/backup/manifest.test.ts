import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encryptFile, parseBackupKey } from "./crypto.js";
import {
  buildManifest,
  manifestPath,
  readManifest,
  verifyBackup,
  writeManifest,
} from "./manifest.js";

/**
 * M15 (P1) + M15B (Hermes D04): the manifest is AUTHENTICATED. Beyond
 * per-artifact ciphertext hashes, an HMAC over the whole body detects any
 * metadata tampering (size, timestamp, role, artifact list). Verify also
 * checks recorded byte sizes and the required postgres role.
 */
describe("backup manifest + verify (authenticated)", () => {
  const key = parseBackupKey(randomBytes(32).toString("hex"));

  async function makeSealedBackup(): Promise<{ dir: string; stamp: string }> {
    const dir = mkdtempSync(join(tmpdir(), "nova-manifest-"));
    const stamp = "20260101T000000Z";
    const dbPlain = join(dir, `nova-db-${stamp}.dump`);
    const mediaPlain = join(dir, `nova-media-${stamp}.tar.gz`);
    writeFileSync(dbPlain, randomBytes(4096));
    writeFileSync(mediaPlain, randomBytes(2048));
    await encryptFile(dbPlain, `${dbPlain}.enc`, key);
    await encryptFile(mediaPlain, `${mediaPlain}.enc`, key);
    const manifest = await buildManifest(
      dir,
      stamp,
      "2026-01-01T00:00:00Z",
      [
        { name: `nova-db-${stamp}.dump.enc`, role: "postgres" },
        { name: `nova-media-${stamp}.tar.gz.enc`, role: "media" },
      ],
      key,
    );
    await writeManifest(dir, manifest);
    return { dir, stamp };
  }

  const rewriteManifest = (dir: string, stamp: string, mutate: (m: any) => void) => {
    const p = manifestPath(dir, stamp);
    const m = JSON.parse(readFileSync(p, "utf8"));
    mutate(m);
    writeFileSync(p, JSON.stringify(m, null, 2));
  };

  it("verifies a good backup — MAC, shape, sizes, hashes, decrypt", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const r = await verifyBackup(dir, stamp, key);
    expect(r.ok).toBe(true);
    expect(r.manifest.shape).toBe("ok");
    expect(r.manifest.mac).toBe("ok");
    expect(r.checks.every((c) => c.hash === "ok" && c.size === "ok" && c.decrypt === "ok")).toBe(true);
  });

  it("MAC catches a tampered byte SIZE (metadata) even if the file is untouched", async () => {
    const { dir, stamp } = await makeSealedBackup();
    rewriteManifest(dir, stamp, (m) => {
      m.artifacts[0].bytes = m.artifacts[0].bytes + 1; // lie about the size
    });
    const r = await verifyBackup(dir, stamp, key);
    expect(r.ok).toBe(false);
    expect(r.manifest.mac).toBe("mismatch");
  });

  it("MAC catches a tampered TIMESTAMP", async () => {
    const { dir, stamp } = await makeSealedBackup();
    rewriteManifest(dir, stamp, (m) => {
      m.created_at = "1999-01-01T00:00:00Z";
    });
    expect((await verifyBackup(dir, stamp, key)).manifest.mac).toBe("mismatch");
  });

  it("MAC catches a tampered ROLE", async () => {
    const { dir, stamp } = await makeSealedBackup();
    rewriteManifest(dir, stamp, (m) => {
      m.artifacts[1].role = "postgres";
    });
    expect((await verifyBackup(dir, stamp, key)).manifest.mac).toBe("mismatch");
  });

  it("rejects a manifest with no postgres artifact (shape)", async () => {
    const { dir, stamp } = await makeSealedBackup();
    rewriteManifest(dir, stamp, (m) => {
      m.artifacts = m.artifacts.filter((a: { role: string }) => a.role !== "postgres");
    });
    const r = await verifyBackup(dir, stamp, key);
    expect(r.ok).toBe(false);
    expect(r.manifest.shape).toBe("invalid");
  });

  it("catches ciphertext tampering via the file hash (no key needed)", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const enc = join(dir, `nova-db-${stamp}.dump.enc`);
    const bytes = readFileSync(enc);
    bytes[10] ^= 0xff;
    writeFileSync(enc, bytes);
    const r = await verifyBackup(dir, stamp, null);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.artifact.includes("db"))!.hash).toBe("mismatch");
  });

  it("a wrong key fails the MAC and the decrypt check", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const wrong = parseBackupKey(randomBytes(32).toString("hex"));
    const r = await verifyBackup(dir, stamp, wrong);
    expect(r.ok).toBe(false);
    expect(r.manifest.mac).toBe("mismatch");
    expect(r.checks.some((c) => c.decrypt === "fail")).toBe(true);
  });

  it("manifest carries no key material", async () => {
    const { dir, stamp } = await makeSealedBackup();
    const m = await readManifest(dir, stamp);
    const raw = JSON.stringify(m);
    expect(raw).not.toContain(key.toString("hex"));
    expect(raw).not.toContain(key.toString("base64"));
  });
});
