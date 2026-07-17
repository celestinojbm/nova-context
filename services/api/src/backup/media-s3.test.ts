import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ObjectStore, StoredObject } from "../media/object-store.js";
import {
  assertDistinctTargets,
  backupMediaToStore,
  backupPrefixFor,
  canonicalizeEndpoint,
  canonicalizeIdentity,
  fingerprint,
  inventoryMac,
  readInventoryFromStore,
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

/** A backup store that silently corrupts one key's bytes on put — models a
 * destination that failed to persist correctly (Phase B must catch it). */
class CorruptingPutStore extends MemStore {
  constructor(private readonly corruptSuffix: string) {
    super();
  }
  override async put(key: string, data: Buffer): Promise<void> {
    if (key.endsWith(this.corruptSuffix)) {
      await super.put(key, randomBytes(data.length + 1));
    } else {
      await super.put(key, data);
    }
  }
}

const KEY = randomBytes(32);
const WRONG_KEY = randomBytes(32);
const STAMP = "20260717T000000Z";

function target(id: string, store: MemStore = new MemStore()): StoreTarget & { store: MemStore } {
  return { store, identity: id } as StoreTarget & { store: MemStore };
}

async function seedPrimary(primary: MemStore, n: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const key = `media/user-${i}/blob-${i}.enc`;
    const thumb = i % 2 === 0 ? `media/user-${i}/thumb-${i}.enc` : null;
    await primary.put(key, randomBytes(64 + i));
    if (thumb) await primary.put(thumb, randomBytes(32 + i));
    rows.push({ storage_key: key, thumb_key: thumb });
  }
  return rows;
}

async function doBackup(
  rows: Awaited<ReturnType<typeof seedPrimary>>,
  source: StoreTarget,
  backup: StoreTarget,
  apply = true,
) {
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

describe("media-s3 backup/verify/restore (M18A + M18A.1)", () => {
  it("complete backup: copies every ciphertext as stored, publishes ONE authenticated inventory as commit marker", async () => {
    const source = target("s3|http://minio|primary");
    const backup = target("s3|http://minio|backup");
    const rows = await seedPrimary(source.store, 3);
    const res = await doBackup(rows, source, backup);
    expect(res.complete).toBe(true);
    expect(res.inventory).not.toBeNull();
    expect(res.missingAtSource).toEqual([]);
    expect(res.failedAtDestination).toEqual([]);
    expect(res.expected).toBe(referencedKeys(rows).length);
    expect(res.inventory!.object_count).toBe(res.expected);
    expect(res.inventory!.expected_object_count).toBe(res.expected);
    expect(res.inventory!.completeness).toBe("complete");
    for (const key of referencedKeys(rows)) {
      expect(backup.store.objects.get(`${backupPrefixFor(STAMP)}${key}`)).toEqual(
        source.store.objects.get(key),
      );
    }
    // Exactly one inventory (the commit marker).
    const inventories = [...backup.store.objects.keys()].filter((k) => k.endsWith("inventory.json"));
    expect(inventories).toHaveLength(1);
    const verify = await verifyMediaBackup(res.inventory!, backup, KEY);
    expect(verify).toMatchObject({ ok: true, missing: 0, altered: 0 });
  });

  it("MISSING source object → fails BEFORE copying, publishes NO inventory", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 2);
    // Delete a referenced source object.
    const victim = rows[0]!.storage_key;
    source.store.objects.delete(victim);
    const res = await doBackup(rows, source, backup);
    expect(res.complete).toBe(false);
    expect(res.inventory).toBeNull();
    expect(res.missingAtSource).toContain(victim);
    expect(res.copied).toBe(0); // nothing copied
    expect(backup.store.objects.size).toBe(0); // no commit marker, no objects
  });

  it("destination verification failure → NO committed inventory (interrupted/failed copy)", async () => {
    const source = target("a");
    const backup = target("b", new CorruptingPutStore("thumb-0.enc"));
    const rows = await seedPrimary(source.store, 2); // user-0 has a thumb
    const res = await doBackup(rows, source, backup);
    expect(res.complete).toBe(false);
    expect(res.inventory).toBeNull();
    expect(res.failedAtDestination.length).toBeGreaterThan(0);
    // No inventory.json commit marker exists.
    expect([...backup.store.objects.keys()].some((k) => k.endsWith("inventory.json"))).toBe(false);
  });

  it("a partial/orphan prefix (no inventory) cannot be restored", async () => {
    const source = target("a");
    const backup = target("b", new CorruptingPutStore("thumb-0.enc"));
    const rows = await seedPrimary(source.store, 2);
    await doBackup(rows, source, backup); // fails to commit
    // readInventoryFromStore returns null → restore has nothing to trust.
    expect(await readInventoryFromStore(backup, STAMP)).toBeNull();
  });

  it("successful rerun resumes and publishes exactly one valid inventory", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 3);
    const first = await doBackup(rows, source, backup);
    expect(first.complete).toBe(true);
    // Simulate interruption: drop one copied object, then re-run.
    const victim = [...backup.store.objects.keys()].find((k) => !k.endsWith("inventory.json"))!;
    backup.store.objects.delete(victim);
    const second = await doBackup(rows, source, backup);
    expect(second.complete).toBe(true);
    expect(second.copied).toBe(1); // only the missing one re-copied
    expect(second.skippedIdentical).toBe(first.copied - 1);
    expect([...backup.store.objects.keys()].filter((k) => k.endsWith("inventory.json"))).toHaveLength(1);
    expect((await verifyMediaBackup(second.inventory!, backup, KEY)).ok).toBe(true);
  });

  it("successful restore into an isolated scratch store at the ORIGINAL keys", async () => {
    const source = target("s3|http://minio|primary");
    const backup = target("s3|http://minio|backup");
    const scratch = target("s3|http://minio|scratch");
    const rows = await seedPrimary(source.store, 2);
    const { inventory } = await doBackup(rows, source, backup);
    const res = await restoreMediaFromBackup({ inv: inventory!, backup, destination: scratch, apply: true });
    expect(res).toMatchObject({ restored: inventory!.object_count, failedVerify: 0 });
    for (const key of referencedKeys(rows)) {
      expect(scratch.store.objects.get(key)).toEqual(source.store.objects.get(key));
    }
  });

  it("missing / altered object fails verification", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 2);
    const { inventory } = await doBackup(rows, source, backup);
    const victim = [...backup.store.objects.keys()].find((k) => !k.endsWith("inventory.json"))!;
    backup.store.objects.set(victim, randomBytes(64));
    const altered = await verifyMediaBackup(inventory!, backup, KEY);
    expect(altered.ok).toBe(false);
    expect(altered.altered).toBeGreaterThan(0);
    backup.store.objects.delete(victim);
    const missing = await verifyMediaBackup(inventory!, backup, KEY);
    expect(missing.ok).toBe(false);
    expect(missing.missing).toBe(1);
  });

  it("altered inventory (any field) and wrong key both fail closed on the MAC", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 1);
    const { inventory } = await doBackup(rows, source, backup);
    const tampered: MediaInventory = {
      ...inventory!,
      objects: inventory!.objects.map((o) => ({ ...o, bytes: o.bytes + 1 })),
    };
    const t = await verifyMediaBackup(tampered, backup, KEY);
    expect(t.ok).toBe(false);
    expect(t.manifest.mac).toBe("mismatch");
    expect(t.verified).toBe(0);
    const wrong = await verifyMediaBackup(inventory!, backup, WRONG_KEY);
    expect(wrong.ok).toBe(false);
    expect(wrong.manifest.mac).toBe("mismatch");
    expect(inventoryMac(inventory!, WRONG_KEY)).not.toBe(inventory!.mac);
  });

  it("an inventory whose completeness/count is downgraded is rejected as incomplete", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 3);
    const { inventory } = await doBackup(rows, source, backup);
    // Drop one object + drop its count but keep expected — a truncated set.
    const truncated = {
      ...inventory!,
      objects: inventory!.objects.slice(0, -1),
      object_count: inventory!.object_count - 1,
    } as MediaInventory;
    const res = await verifyMediaBackup(truncated, backup, KEY);
    expect(res.ok).toBe(false); // count mismatch / MAC mismatch
  });

  it("source/destination aliasing is refused, incl. canonicalized endpoint variants", async () => {
    const same = "s3|http://minio:9000/|bucket-x";
    const sameAlias = "s3|HTTP://MinIO:9000|bucket-x"; // trailing slash + case
    expect(() => assertDistinctTargets(target(same), target(sameAlias), "t")).toThrow(/aliasing refused/);
    const source = target("s3|http://minio|primary");
    const backup = target("s3|http://minio|backup");
    const rows = await seedPrimary(source.store, 1);
    const { inventory } = await doBackup(rows, source, backup);
    // Restore refuses destination === original primary — even a trailing-slash
    // / uppercase variant of the same endpoint+bucket.
    await expect(
      restoreMediaFromBackup({
        inv: inventory!,
        backup,
        destination: target("s3|HTTP://minio/|primary"),
        apply: false,
      }),
    ).rejects.toThrow(/ORIGINAL primary/);
  });

  it("empty media set produces a valid, verifiable empty inventory", async () => {
    const source = target("a");
    const backup = target("b");
    const res = await doBackup([], source, backup);
    expect(res.complete).toBe(true);
    expect(res.inventory!.object_count).toBe(0);
    expect(res.inventory!.expected_object_count).toBe(0);
    const verify = await verifyMediaBackup(res.inventory!, backup, KEY);
    expect(verify).toMatchObject({ ok: true, objectCount: 0 });
  });

  it("dry run (no --apply) writes nothing to the backup store", async () => {
    const source = target("a");
    const backup = target("b");
    const rows = await seedPrimary(source.store, 2);
    const res = await doBackup(rows, source, backup, false);
    expect(res.applied).toBe(false);
    expect(res.complete).toBe(true);
    expect(backup.store.objects.size).toBe(0);
    expect(res.inventory!.object_count).toBe(referencedKeys(rows).length);
  });

  it("results and inventory carry no plaintext or key material (counts/hashes/keys only)", async () => {
    const source = target("a");
    const backup = target("b");
    const secret = Buffer.from("data:image/png;base64,SUPER_SECRET_PIXELS");
    await source.store.put("media/u/blob.enc", secret);
    const res = await doBackup([{ storage_key: "media/u/blob.enc", thumb_key: null }], source, backup);
    const serialized = JSON.stringify(res.inventory);
    expect(serialized).not.toContain("SUPER_SECRET_PIXELS");
    expect(serialized).not.toContain(KEY.toString("hex"));
    expect(Object.keys(res.inventory!.objects[0]!).sort()).toEqual(["bytes", "key", "sha256"]);
  });
});

describe("object-store identity canonicalization (M18A.1 finding 7)", () => {
  it("canonicalizes endpoints: scheme/host case, default ports, trailing slash", () => {
    expect(canonicalizeEndpoint("HTTP://MinIO:80/")).toBe("http://minio");
    expect(canonicalizeEndpoint("https://Host:443")).toBe("https://host");
    expect(canonicalizeEndpoint("http://h:9000/")).toBe("http://h:9000");
    expect(canonicalizeEndpoint(undefined)).toBe("aws");
    expect(canonicalizeEndpoint("aws")).toBe("aws");
  });

  it("aliased identities fingerprint identically; genuinely-different ones do not", () => {
    expect(fingerprint("s3|http://minio:9000/|b")).toBe(fingerprint("s3|HTTP://MinIO:9000|b"));
    expect(fingerprint("fs|/data/media/")).toBe(fingerprint("fs|/data/media"));
    expect(fingerprint("s3|http://minio|a")).not.toBe(fingerprint("s3|http://minio|b"));
    expect(canonicalizeIdentity("s3|https://x:443/|bkt")).toBe("s3|https://x|bkt");
  });
});
