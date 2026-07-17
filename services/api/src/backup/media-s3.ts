import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectStore } from "../media/object-store.js";

/**
 * M18A: provider-compatible media backup for the S3 object store.
 *
 * `scripts/backup.sh` tars the FS media root — but an S3/R2 store has no
 * local root, so before M18A an S3 deployment silently relied on external
 * bucket controls and could NOT execute a complete isolated recovery drill.
 * This module closes that gap with three operator commands built on the
 * EXISTING ObjectStore abstraction (MinIO locally, S3/R2 in production):
 *
 *   media:backup-s3         copy DB-referenced encrypted blobs, AS STORED,
 *                           from the primary store into a SEPARATE backup
 *                           store under media/<stamp>/, and write an
 *                           HMAC-authenticated inventory
 *   media:verify-backup-s3  verify the inventory MAC + every backed-up
 *                           object's size/sha256 (fails closed on a wrong
 *                           NOVA_BACKUP_KEY or any tampering)
 *   media:restore-s3        copy the backed-up blobs into an ISOLATED
 *                           scratch store at their ORIGINAL keys (so the
 *                           restored database references resolve), refusing
 *                           aliased or primary destinations
 *
 * Invariants (M15/M15B lineage):
 *   - blobs are AES-256-GCM ciphertext BEFORE they reach any store; backup
 *     copies bytes verbatim and NEVER decrypts (no plaintext artifacts);
 *   - the inventory is authenticated with NOVA_BACKUP_KEY (HMAC-SHA256 over
 *     a canonical body — same pattern as the sealed-backup manifest), so a
 *     wrong key or an altered inventory fails closed;
 *   - console output carries counts/bytes only — never object keys, never
 *     content; the inventory file itself is a private backup artifact;
 *   - copy operations are dry-run by default (`--apply` writes), idempotent
 *     (already-identical destination objects are skipped), and guarded
 *     against source/destination aliasing.
 */

export interface MediaInventoryEntry {
  key: string; // original object key (needed by database references)
  bytes: number; // ciphertext size, as stored
  sha256: string; // over the ciphertext — integrity without any key
}

export interface MediaInventoryBody {
  format_version: 1;
  kind: "media-s3-inventory";
  stamp: string;
  created_at: string;
  source_role: "primary-media";
  destination_role: "media-backup";
  /** Prefix inside the backup store where objects live. */
  backup_prefix: string;
  /** sha256 fingerprint of the SOURCE store identity (endpoint|bucket or
   * fs|root). Lets restore refuse writing back onto the original primary
   * without embedding the bucket name in the artifact. */
  source_fingerprint: string;
  object_count: number;
  total_bytes: number;
  objects: MediaInventoryEntry[];
  notes: string[];
}

export interface MediaInventory extends MediaInventoryBody {
  /** HMAC-SHA256 of the canonical body, keyed with NOVA_BACKUP_KEY. */
  mac: string;
}

export function inventoryFileName(stamp: string): string {
  return `media-inventory-${stamp}.json`;
}

export function backupPrefixFor(stamp: string): string {
  return `media/${stamp}/`;
}

/** Stable identity string for an object-store target (never printed). */
export interface StoreTarget {
  store: ObjectStore;
  /** e.g. "s3|https://endpoint|bucket" or "fs|/abs/root" */
  identity: string;
}

export function fingerprint(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

/** Refuse aliased source/destination (same physical store target). */
export function assertDistinctTargets(a: StoreTarget, b: StoreTarget, what: string): void {
  if (fingerprint(a.identity) === fingerprint(b.identity)) {
    throw new Error(
      `${what}: source and destination resolve to the SAME object store — ` +
        "media backup/restore requires physically separate targets (aliasing refused).",
    );
  }
}

function canonicalBody(body: MediaInventoryBody): string {
  return JSON.stringify({
    backup_prefix: body.backup_prefix,
    created_at: body.created_at,
    destination_role: body.destination_role,
    format_version: body.format_version,
    kind: body.kind,
    notes: body.notes,
    object_count: body.object_count,
    objects: body.objects
      .map((o) => ({ bytes: o.bytes, key: o.key, sha256: o.sha256 }))
      .sort((x, y) => x.key.localeCompare(y.key)),
    source_fingerprint: body.source_fingerprint,
    source_role: body.source_role,
    stamp: body.stamp,
    total_bytes: body.total_bytes,
  });
}

export function inventoryMac(body: MediaInventoryBody, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalBody(body)).digest("hex");
}

function macMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

export interface MediaKeyRow {
  storage_key: string;
  thumb_key: string | null;
}

/** Distinct object keys referenced by the database (source of truth — the
 * same enumeration media:verify uses, so backup and verification agree). */
export function referencedKeys(rows: MediaKeyRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(r.storage_key);
    if (r.thumb_key) keys.add(r.thumb_key);
  }
  return [...keys].sort();
}

export interface BackupMediaResult {
  inventory: MediaInventory;
  copied: number;
  skippedIdentical: number;
  missingAtSource: string[];
  applied: boolean;
}

/**
 * Copy every DB-referenced encrypted blob from `source` into `backup` under
 * media/<stamp>/<original-key>, and build the authenticated inventory.
 * Dry run (default): reads + hashes the source, writes NOTHING.
 * `apply`: copies (idempotently) and uploads the inventory alongside the
 * objects at media/<stamp>/inventory.json.
 */
export async function backupMediaToStore(opts: {
  rows: MediaKeyRow[];
  source: StoreTarget;
  backup: StoreTarget;
  stamp: string;
  createdAt: string;
  backupKey: Buffer;
  apply: boolean;
}): Promise<BackupMediaResult> {
  assertDistinctTargets(opts.source, opts.backup, "media:backup-s3");
  const prefix = backupPrefixFor(opts.stamp);
  const keys = referencedKeys(opts.rows);
  const objects: MediaInventoryEntry[] = [];
  const missingAtSource: string[] = [];
  let copied = 0;
  let skippedIdentical = 0;

  for (const key of keys) {
    const blob = await opts.source.store.get(key);
    if (!blob) {
      missingAtSource.push(key);
      continue;
    }
    const digest = sha256(blob);
    objects.push({ key, bytes: blob.length, sha256: digest });
    if (!opts.apply) continue;
    const destKey = `${prefix}${key}`;
    const existing = await opts.backup.store.get(destKey);
    if (existing && sha256(existing) === digest) {
      skippedIdentical += 1; // resumable/idempotent re-run
      continue;
    }
    await opts.backup.store.put(destKey, blob);
    copied += 1;
  }

  const body: MediaInventoryBody = {
    format_version: 1,
    kind: "media-s3-inventory",
    stamp: opts.stamp,
    created_at: opts.createdAt,
    source_role: "primary-media",
    destination_role: "media-backup",
    backup_prefix: prefix,
    source_fingerprint: fingerprint(opts.source.identity),
    object_count: objects.length,
    total_bytes: objects.reduce((n, o) => n + o.bytes, 0),
    objects,
    notes: [
      "Objects are AES-256-GCM ciphertext copied AS STORED — never decrypted.",
      "NOVA_ENCRYPTION_KEY is NOT in this backup; restore recovers ciphertext",
      "that still requires the data key. Inventory MAC uses NOVA_BACKUP_KEY.",
    ],
  };
  const inventory: MediaInventory = { ...body, mac: inventoryMac(body, opts.backupKey) };

  if (opts.apply) {
    await opts.backup.store.put(
      `${prefix}inventory.json`,
      Buffer.from(JSON.stringify(inventory, null, 2)),
    );
  }
  return { inventory, copied, skippedIdentical, missingAtSource, applied: opts.apply };
}

export async function writeInventoryFile(dir: string, inventory: MediaInventory): Promise<string> {
  const p = join(dir, inventoryFileName(inventory.stamp));
  await writeFile(p, JSON.stringify(inventory, null, 2), { mode: 0o600 });
  return p;
}

export async function readInventoryFile(dir: string, stamp: string): Promise<MediaInventory> {
  const raw = await readFile(join(dir, inventoryFileName(stamp)), "utf8");
  return JSON.parse(raw) as MediaInventory;
}

export async function readInventoryFromStore(
  backup: StoreTarget,
  stamp: string,
): Promise<MediaInventory | null> {
  const raw = await backup.store.get(`${backupPrefixFor(stamp)}inventory.json`);
  return raw ? (JSON.parse(raw.toString("utf8")) as MediaInventory) : null;
}

function validateShape(inv: MediaInventory): string | null {
  if (inv.format_version !== 1 || inv.kind !== "media-s3-inventory") return "unexpected header";
  if (typeof inv.stamp !== "string" || typeof inv.created_at !== "string") return "bad header";
  if (typeof inv.mac !== "string" || !/^[0-9a-f]{64}$/.test(inv.mac)) return "missing/invalid mac";
  if (typeof inv.backup_prefix !== "string" || typeof inv.source_fingerprint !== "string")
    return "bad target metadata";
  if (!Array.isArray(inv.objects)) return "bad objects";
  for (const o of inv.objects) {
    if (typeof o.key !== "string" || typeof o.bytes !== "number" || o.bytes < 0) return "bad entry";
    if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256)) return "bad entry sha256";
  }
  if (inv.object_count !== inv.objects.length) return "object_count mismatch";
  return null;
}

export interface VerifyBackupResult {
  ok: boolean;
  manifest: { shape: "ok" | "invalid"; mac: "ok" | "mismatch"; detail?: string };
  objectCount: number;
  verified: number;
  missing: number;
  altered: number;
}

/** Authenticate the inventory (fail closed on wrong key/tamper), then prove
 * every entry exists in the backup store with the recorded size + sha256.
 * Read-only; never decrypts; reports counts only. */
export async function verifyMediaBackup(
  inv: MediaInventory,
  backup: StoreTarget,
  backupKey: Buffer,
): Promise<VerifyBackupResult> {
  const shapeError = validateShape(inv);
  if (shapeError) {
    return {
      ok: false,
      manifest: { shape: "invalid", mac: "mismatch", detail: shapeError },
      objectCount: 0,
      verified: 0,
      missing: 0,
      altered: 0,
    };
  }
  const { mac, ...body } = inv;
  if (!macMatches(inventoryMac(body, backupKey), mac ?? "")) {
    // Wrong NOVA_BACKUP_KEY or altered inventory: nothing else is trusted.
    return {
      ok: false,
      manifest: { shape: "ok", mac: "mismatch" },
      objectCount: inv.objects.length,
      verified: 0,
      missing: 0,
      altered: 0,
    };
  }
  let verified = 0;
  let missing = 0;
  let altered = 0;
  for (const o of inv.objects) {
    const blob = await backup.store.get(`${inv.backup_prefix}${o.key}`);
    if (!blob) {
      missing += 1;
      continue;
    }
    if (blob.length !== o.bytes || sha256(blob) !== o.sha256) altered += 1;
    else verified += 1;
  }
  return {
    ok: missing === 0 && altered === 0,
    manifest: { shape: "ok", mac: "ok" },
    objectCount: inv.objects.length,
    verified,
    missing,
    altered,
  };
}

export interface RestoreMediaResult {
  restored: number;
  skippedIdentical: number;
  failedVerify: number;
  applied: boolean;
}

/**
 * Copy backed-up blobs into the scratch destination at their ORIGINAL keys.
 * The inventory MUST verify first (call verifyMediaBackup). Refuses:
 *   - destination aliased with the backup store;
 *   - destination fingerprint matching the inventory's ORIGINAL primary
 *     source (restoring over production media), unless the operator sets
 *     NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes (true disaster recovery only).
 * Dry-run by default; `apply` writes; identical destination objects are
 * skipped (idempotent); every written object is re-read and hash-checked.
 */
export async function restoreMediaFromBackup(opts: {
  inv: MediaInventory;
  backup: StoreTarget;
  destination: StoreTarget;
  apply: boolean;
  allowPrimaryDestination?: boolean;
}): Promise<RestoreMediaResult> {
  assertDistinctTargets(opts.backup, opts.destination, "media:restore-s3");
  if (
    fingerprint(opts.destination.identity) === opts.inv.source_fingerprint &&
    !opts.allowPrimaryDestination
  ) {
    throw new Error(
      "media:restore-s3 refuses to restore into the ORIGINAL primary media store. " +
        "Recovery drills use an isolated scratch destination. For true disaster " +
        "recovery over the primary, set NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes explicitly.",
    );
  }
  let restored = 0;
  let skippedIdentical = 0;
  let failedVerify = 0;
  for (const o of opts.inv.objects) {
    const blob = await opts.backup.store.get(`${opts.inv.backup_prefix}${o.key}`);
    if (!blob || blob.length !== o.bytes || sha256(blob) !== o.sha256) {
      failedVerify += 1; // verify step should have caught this; fail closed
      continue;
    }
    if (!opts.apply) continue;
    const existing = await opts.destination.store.get(o.key);
    if (existing && sha256(existing) === o.sha256) {
      skippedIdentical += 1;
      continue;
    }
    await opts.destination.store.put(o.key, blob);
    const written = await opts.destination.store.get(o.key);
    if (!written || sha256(written) !== o.sha256) {
      failedVerify += 1;
      continue;
    }
    restored += 1;
  }
  return { restored, skippedIdentical, failedVerify, applied: opts.apply };
}
