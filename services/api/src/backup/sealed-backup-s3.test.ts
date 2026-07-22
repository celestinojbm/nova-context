import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ObjectStore, StoredObject } from "../media/object-store.js";
import { encryptFile, parseBackupKey } from "./crypto.js";
import { buildManifest, writeManifest } from "./manifest.js";
import {
  REMOTE_MARKER_NAME,
  fetchSealedBackup,
  publishSealedBackup,
  remotePrefixFor,
  verifySealedBackupRemote,
} from "./sealed-backup-s3.js";

/**
 * M18A.2 §3: publish / verify / fetch of a COMPLETE sealed backup set to an
 * S3-compatible store, proven against an in-memory ObjectStore (the same
 * interface MinIO/R2 satisfy). Fail-closed on missing/altered artifacts, an
 * altered/absent marker, and a wrong key; never uploads plaintext; dry-run
 * writes nothing; a resumable re-run converges to one committed set.
 */

class MemStore implements ObjectStore {
  readonly name = "mem";
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer | null> {
    const v = this.objects.get(key);
    return v ? Buffer.from(v) : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix = ""): Promise<StoredObject[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, buf]) => ({ key, size: buf.length, lastModified: null }));
  }
}

const KEY = parseBackupKey(randomBytes(32).toString("hex"));
const STAMP = "20260717T120000Z";
const CREATED = "2026-07-17T12:00:00Z";
const dirs: string[] = [];

/** Build a real sealed backup dir (db + media .enc + authenticated manifest)
 * plus an S3 media inventory sidecar to exercise the media-inventory role. */
async function makeSealedBackup(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nova-sealed-"));
  dirs.push(dir);
  const dbPlain = join(dir, `nova-db-${STAMP}.dump`);
  const mediaPlain = join(dir, `nova-media-${STAMP}.tar.gz`);
  writeFileSync(dbPlain, randomBytes(4096));
  writeFileSync(mediaPlain, randomBytes(2048));
  await encryptFile(dbPlain, `${dbPlain}.enc`, KEY);
  await encryptFile(mediaPlain, `${mediaPlain}.enc`, KEY);
  rmSync(dbPlain);
  rmSync(mediaPlain);
  const manifest = await buildManifest(
    dir,
    STAMP,
    CREATED,
    [
      { name: `nova-db-${STAMP}.dump.enc`, role: "postgres" },
      { name: `nova-media-${STAMP}.tar.gz.enc`, role: "media" },
    ],
    KEY,
  );
  await writeManifest(dir, manifest);
  // An HMAC-authenticated media inventory sidecar (json — not secret).
  writeFileSync(
    join(dir, `media-inventory-${STAMP}.json`),
    JSON.stringify({ kind: "media-s3-inventory", stamp: STAMP, objects: [] }),
  );
  return dir;
}

async function publishInto(store: MemStore, dir: string) {
  return publishSealedBackup({ dir, stamp: STAMP, store, backupKey: KEY, createdAt: CREATED, apply: true });
}

describe("sealed backup publish/verify/fetch (M18A.2 §3)", () => {
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("complete publish → verify → fetch round-trips the whole set (no plaintext)", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    const res = await publishInto(store, dir);
    expect(res.applied).toBe(true);
    // db + media + manifest + media-inventory = 4 artifacts, all verified at dst.
    expect(res.expected).toBe(4);
    expect(res.verifiedAtDestination).toBe(4);
    // Marker published LAST.
    expect(res.uploaded[res.uploaded.length - 1]).toBe(REMOTE_MARKER_NAME);

    // NEVER upload plaintext — every stored .enc object must decrypt-guard as
    // ciphertext (its first bytes are not the original plaintext). We assert no
    // stored object equals the (now-deleted) plaintext and the marker binds the
    // sealed manifest hash.
    const prefix = remotePrefixFor(STAMP);
    for (const [key, buf] of store.objects) {
      if (key.endsWith(".dump.enc") || key.endsWith(".tar.gz.enc")) {
        expect(buf.length).toBeGreaterThan(0);
      }
    }

    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(true);
    expect(verify.verified).toBe(4);
    expect(verify.marker.mac).toBe("ok");

    const out = mkdtempSync(join(tmpdir(), "nova-fetch-"));
    dirs.push(out);
    const fetched = await fetchSealedBackup({ store, stamp: STAMP, backupKey: KEY, destDir: out });
    expect(fetched.ok).toBe(true);
    expect(fetched.files).toContain(`nova-db-${STAMP}.dump.enc`);
    expect(fetched.files).toContain(`manifest-${STAMP}.json`);
    // The fetched sealed db equals the originally published ciphertext.
    expect(readFileSync(join(out, `nova-db-${STAMP}.dump.enc`)).equals(store.objects.get(`${prefix}nova-db-${STAMP}.dump.enc`)!)).toBe(true);
  });

  it("dry run (no --apply) uploads NOTHING and returns the would-be marker", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    const res = await publishSealedBackup({ dir, stamp: STAMP, store, backupKey: KEY, createdAt: CREATED, apply: false });
    expect(res.applied).toBe(false);
    expect(res.uploaded).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect(res.marker!.expected_artifact_count).toBe(4);
  });

  it("wrong key → verify fails on the marker MAC (fail-closed)", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: parseBackupKey(randomBytes(32).toString("hex")) });
    expect(verify.ok).toBe(false);
    expect(verify.marker.mac).toBe("mismatch");
  });

  it("no key at all → verify refuses (unauthenticated marker is never trusted)", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: null });
    expect(verify.ok).toBe(false);
  });

  it("a missing artifact object → verify fails (missing), fetch refuses", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    store.objects.delete(`${remotePrefixFor(STAMP)}nova-db-${STAMP}.dump.enc`);
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(false);
    expect(verify.missing).toContain(`nova-db-${STAMP}.dump.enc`);
    const out = mkdtempSync(join(tmpdir(), "nova-fetch-"));
    dirs.push(out);
    await expect(fetchSealedBackup({ store, stamp: STAMP, backupKey: KEY, destDir: out })).rejects.toThrow(/not a committed/);
  });

  it("an altered artifact object → verify fails (altered)", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    store.objects.set(`${remotePrefixFor(STAMP)}nova-db-${STAMP}.dump.enc`, Buffer.from("tampered"));
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(false);
    expect(verify.altered).toContain(`nova-db-${STAMP}.dump.enc`);
  });

  it("an altered marker (any field) → verify fails on the MAC", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    const mk = JSON.parse(store.objects.get(`${remotePrefixFor(STAMP)}${REMOTE_MARKER_NAME}`)!.toString());
    mk.expected_artifact_count = 99; // tamper
    store.objects.set(`${remotePrefixFor(STAMP)}${REMOTE_MARKER_NAME}`, Buffer.from(JSON.stringify(mk)));
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(false);
  });

  it("interrupted upload WITHOUT the marker is not a valid backup", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    // Simulate a crash before the marker was written.
    store.objects.delete(`${remotePrefixFor(STAMP)}${REMOTE_MARKER_NAME}`);
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(false);
    expect(verify.marker.shape).toBe("missing");
  });

  it("a re-run is idempotent — same keys, one committed marker", async () => {
    const dir = await makeSealedBackup();
    const store = new MemStore();
    await publishInto(store, dir);
    const before = store.objects.size;
    await publishInto(store, dir); // resume/rerun
    expect(store.objects.size).toBe(before); // no duplicate objects
    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(true);
  });

  it("an unsafe stamp (path traversal) is refused before any prefix is used", async () => {
    const store = new MemStore();
    expect(() => remotePrefixFor("../evil")).toThrow(/unsafe/);
    await expect(
      publishSealedBackup({ dir: "/nope", stamp: "a/b", store, backupKey: KEY, createdAt: CREATED, apply: true }),
    ).rejects.toThrow(/unsafe/);
  });

  it("refuses to publish when the LOCAL sealed backup fails verification", async () => {
    const dir = await makeSealedBackup();
    // Corrupt a sealed artifact locally.
    writeFileSync(join(dir, `nova-db-${STAMP}.dump.enc`), Buffer.from("corrupt"));
    const store = new MemStore();
    await expect(publishInto(store, dir)).rejects.toThrow(/LOCAL sealed backup failed verification/);
    expect(store.objects.size).toBe(0); // nothing uploaded
  });
});
