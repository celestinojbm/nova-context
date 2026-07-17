import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ObjectStore, StoredObject } from "../media/object-store.js";
import {
  assertDistinctTargets,
  backupMediaToStore,
  backupPrefixFor,
  fingerprint,
  inventoryMac,
  referencedKeys,
  restoreMediaFromBackup,
  verifyMediaBackup,
  type MediaInventory,
  type StoreTarget,
} from "./media-s3.js";

/** In-memory ObjectStore — the same interface MinIO/R2 satisfy, so every
 * safety property is provable without infrastructure. */
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
      .map(([key, v]) => ({ key, size: v.length, lastModified: null }));
  }
}

const KEY = randomBytes(32);
const WRONG_KEY = randomBytes(32);
const STAMP = "20260717T000000Z";

function target(id: string, store = new MemStore()): StoreTarget & { store: MemStore } {
  return { store, identity: id } as StoreTarget & { store: MemStore };
}

async function seedPrimary(primary: MemStore, n: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const key = `media/user-${i}/blob-${i}.enc`;
    const thumb = i % 2 === 0 ? `media/user-${i}/thumb-${i}.enc` : null;
    // "ciphertext" — opaque bytes; nothing here ever decrypts them.
    await primary.put(key, randomBytes(64 + i));
    if (thumb) await primary.put(thumb, randomBytes(32 + i));
    rows.push({ storage_key: key, thumb_key: thumb });
  }
  return rows;
}

async function doBackup(rows: Awaited<ReturnType<typeof seedPrimary>>, source: StoreTarget, backup: StoreTarget, apply = true) {
  return backupMediaToStore({
    rows,
    source,
    backup,
    stamp: STAMP,
    createdAt: "2026-07-17T00:00:00Z",
    backupKey: KEY,
    apply,
  });
}

describe("media-s3 backup/verify/restore (M18A)", () => {
  it("successful backup: copies every referenced ciphertext as stored + authenticated inventory", async () => {
    const source = target("s3|http://minio|primary");
    const backup = target("s3|http://minio|backup");
    const rows = await seedPrimary(source.store, 3);
    const res = await doBackup(rows, source, backup);
    expect(res.missingAtSource).toEqual([]);
    expect(res.copied).toBe(referencedKeys(rows).length);
    // Bytes are copied verbatim (never decrypted, never transformed).
    for (const key of referencedKeys(rows)) {
      expect(backup.store.objects.get(`${backupPrefixFor(STAMP)}${key}`)).toEqual(
        source.store.objects.get(key),
      );
    }
    // Inventory is authenticated and stored alongside the objects.
    const verify = await verifyMediaBackup(res.inventory, backup, KEY);
    expect(verify).toMatchObject({ ok: true, missing: 0, altered: 0 });
    expect(backup.store.objects.has(`${backupPrefixFor(STAMP)}inventory.json`)).toBe(true);
  });

  it("successful restore into an isolated scratch store at the ORIGINAL keys", async () => {
    const source = target("s3|http://minio|primary");
    const backup = target("s3|http://minio|backup");
    const scratch = target("s3|http://minio|scratch");
    const rows = await seedPrimary(source.store, 2);
    const { inventory } = await doBackup(rows, source, backup);
    const res = await restoreMediaFromBackup({ inv: inventory, backup, destination: scratch, apply: true });
    expect(res).toMatchObject({ restored: inventory.object_count, failedVerify: 0 });
    for (const key of referencedKeys(rows)) {
      expect(scratch.store.objects.get(key)).toEqual(source.store.objects.get(key));
    }
  });

  it("missing object in the backup store fails verification", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 2);
    const { inventory } = await doBackup(rows, source, backup);
    const victim = [...backup.store.objects.keys()].find((k) => !k.endsWith("inventory.json"))!;
    backup.store.objects.delete(victim);
    const verify = await verifyMediaBackup(inventory, backup, KEY);
    expect(verify.ok).toBe(false);
    expect(verify.missing).toBe(1);
  });

  it("altered object bytes fail verification", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 2);
    const { inventory } = await doBackup(rows, source, backup);
    const victim = [...backup.store.objects.keys()].find((k) => !k.endsWith("inventory.json"))!;
    backup.store.objects.set(victim, randomBytes(64));
    const verify = await verifyMediaBackup(inventory, backup, KEY);
    expect(verify.ok).toBe(false);
    expect(verify.altered).toBeGreaterThan(0);
  });

  it("altered inventory (any field) fails closed on the MAC", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 1);
    const { inventory } = await doBackup(rows, source, backup);
    const tampered: MediaInventory = {
      ...inventory,
      objects: inventory.objects.map((o) => ({ ...o, bytes: o.bytes + 1 })),
    };
    const verify = await verifyMediaBackup(tampered, backup, KEY);
    expect(verify.ok).toBe(false);
    expect(verify.manifest.mac).toBe("mismatch");
    expect(verify.verified).toBe(0); // nothing trusted after MAC failure
  });

  it("wrong backup key fails closed before any object check", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 1);
    const { inventory } = await doBackup(rows, source, backup);
    const verify = await verifyMediaBackup(inventory, backup, WRONG_KEY);
    expect(verify.ok).toBe(false);
    expect(verify.manifest.mac).toBe("mismatch");
    // And restore refuses a failed-verification inventory by contract: the
    // CLI verifies first; the core additionally re-hashes every object.
    expect(inventoryMac(inventory, WRONG_KEY)).not.toBe(inventory.mac);
  });

  it("source/destination aliasing is refused (backup AND restore)", async () => {
    const same = "s3|http://minio|bucket-x";
    expect(() => assertDistinctTargets(target(same), target(same), "t")).toThrow(/aliasing refused/);
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 1);
    const { inventory } = await doBackup(rows, source, backup);
    // Restore refuses destination === original primary (fingerprint match).
    await expect(
      restoreMediaFromBackup({ inv: inventory, backup, destination: target("a"), apply: false }),
    ).rejects.toThrow(/ORIGINAL primary/);
    // …unless the explicit disaster-recovery override is set.
    const back = await restoreMediaFromBackup({
      inv: inventory,
      backup,
      destination: target("a"),
      apply: false,
      allowPrimaryDestination: true,
    });
    expect(back.applied).toBe(false);
    expect(fingerprint("a")).toBe(inventory.source_fingerprint);
  });

  it("interrupted backup re-run is idempotent (identical objects skipped, result complete)", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 3);
    const first = await doBackup(rows, source, backup);
    // Simulate interruption: drop one copied object, then re-run.
    const victim = [...backup.store.objects.keys()].find((k) => !k.endsWith("inventory.json"))!;
    backup.store.objects.delete(victim);
    const second = await doBackup(rows, source, backup);
    expect(second.copied).toBe(1); // only the missing one re-copied
    expect(second.skippedIdentical).toBe(first.copied - 1);
    const verify = await verifyMediaBackup(second.inventory, backup, KEY);
    expect(verify.ok).toBe(true);
  });

  it("empty media set produces a valid, verifiable empty inventory", async () => {
    const source = target("a");
    const backup = target("b");
    const res = await doBackup([], source, backup);
    expect(res.inventory.object_count).toBe(0);
    expect(res.inventory.total_bytes).toBe(0);
    const verify = await verifyMediaBackup(res.inventory, backup, KEY);
    expect(verify).toMatchObject({ ok: true, objectCount: 0 });
  });

  it("dry run (no --apply) writes nothing to the backup store", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 2);
    const res = await doBackup(rows, source, backup, false);
    expect(res.applied).toBe(false);
    expect(backup.store.objects.size).toBe(0);
    // Inventory is still computed (hashes from the source) for inspection.
    expect(res.inventory.object_count).toBe(referencedKeys(rows).length);
  });

  it("results and inventory carry no plaintext or key material (counts/hashes/keys only)", async () => {
    const source = target("a");
    const backup = target("b");
    const secret = Buffer.from("data:image/png;base64,SUPER_SECRET_PIXELS");
    await source.store.put("media/u/blob.enc", secret); // pretend-ciphertext with sentinel bytes
    const res = await doBackup([{ storage_key: "media/u/blob.enc", thumb_key: null }], source, backup);
    const serialized = JSON.stringify(res.inventory);
    expect(serialized).not.toContain("SUPER_SECRET_PIXELS");
    expect(serialized).not.toContain(KEY.toString("hex"));
    // Only key names, sizes, hashes: entry shape is exactly {key,bytes,sha256}.
    expect(Object.keys(res.inventory.objects[0]!).sort()).toEqual(["bytes", "key", "sha256"]);
  });
});
