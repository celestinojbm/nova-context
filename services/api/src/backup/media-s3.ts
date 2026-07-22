import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalizeEndpoint,
  canonicalizeIdentity,
  fingerprintIdentity,
  type ObjectStore,
} from "../media/object-store.js";

// Re-export the shared object-store identity guards (defined in
// @nova/context-engine so the Validation Gate can reuse the SAME
// canonicalization). `fingerprint` is the local alias kept for existing call
// sites/tests.
export { canonicalizeEndpoint, canonicalizeIdentity };
export const fingerprint = fingerprintIdentity;

/**
 * M18A / M18A.1: provider-compatible media backup for the S3 object store.
 *
 * `scripts/backup.sh` tars the FS media root — but an S3/R2 store has no
 * local root, so before M18A an S3 deployment silently relied on external
 * bucket controls and could NOT execute a complete isolated recovery drill.
 * This module closes that gap with three operator commands built on the
 * EXISTING ObjectStore abstraction (MinIO locally, S3/R2 in production).
 *
 * M18A.1 hardening — the backup is ATOMIC and FAIL-CLOSED:
 *   - Phase A (completeness scan): the COMPLETE distinct DB-referenced key
 *     set is enumerated and every source object is read + hashed. If ANY
 *     source object is missing or unreadable, the backup fails BEFORE any
 *     copy and NO inventory is published anywhere — an incomplete set can
 *     never masquerade as a backup.
 *   - Phase B (copy + commit): every verified ciphertext object is copied,
 *     then EVERY destination object is re-read and hash-checked. Only after
 *     all destination verification succeeds is the authenticated inventory
 *     published — LAST — as the backup-set COMMIT MARKER. Partial ciphertext
 *     from an interrupted run may remain for resumability, but without a
 *     final authenticated inventory it is never recognized as complete.
 *   - The inventory binds (via HMAC-SHA256 over a canonical body, keyed with
 *     NOVA_BACKUP_KEY): expected DB-referenced object count, copied count,
 *     total encrypted bytes, source fingerprint, backup prefix, and an
 *     explicit `completeness` status. The verifier rejects any inventory
 *     that is incomplete, count-mismatched, wrong-HMAC, or references a
 *     missing/altered object.
 *
 * Invariants (M15/M15B lineage): blobs are AES-256-GCM ciphertext BEFORE they
 * reach any store; backup copies bytes verbatim and NEVER decrypts (no
 * plaintext artifacts); console output carries counts/bytes only.
 */

export interface MediaInventoryEntry {
  key: string; // original object key (needed by database references)
  bytes: number; // ciphertext size, as stored
  sha256: string; // over the ciphertext — integrity without any key
}

export interface MediaInventoryBody {
  format_version: 2; // M18A.1 bumped: adds completeness + expected count
  kind: "media-s3-inventory";
  stamp: string;
  created_at: string;
  source_role: "primary-media";
  destination_role: "media-backup";
  /** Prefix inside the backup store where objects live. */
  backup_prefix: string;
  /** Canonicalized-then-hashed identity of the SOURCE store (see
   * `fingerprint`). Lets restore refuse writing back onto the original
   * primary without embedding the bucket name in the artifact. */
  source_fingerprint: string;
  /** Distinct DB-referenced object count this backup MUST cover (Phase A). */
  expected_object_count: number;
  /** Objects actually captured (== expected in a complete inventory). */
  object_count: number;
  total_bytes: number;
  /** Only "complete" is ever published; the verifier rejects anything else. */
  completeness: "complete";
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

/** A store target: the store plus its (pre-canonicalization) identity string. */
export interface StoreTarget {
  store: ObjectStore;
  identity: string;
}

/** Refuse aliased source/destination (same physical store target). */
export function assertDistinctTargets(a: StoreTarget, b: StoreTarget, what: string): void {
  if (fingerprint(a.identity) === fingerprint(b.identity)) {
    throw new Error(
      `${what}: source and destination resolve to the SAME object store ` +
        "(after endpoint/bucket canonicalization) — media backup/restore " +
        "requires physically separate targets (aliasing refused).",
    );
  }
}

function canonicalBody(body: MediaInventoryBody): string {
  return JSON.stringify({
    backup_prefix: body.backup_prefix,
    completeness: body.completeness,
    created_at: body.created_at,
    destination_role: body.destination_role,
    expected_object_count: body.expected_object_count,
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
  /** Present ONLY on a complete, committed backup; null when incomplete. */
  inventory: MediaInventory | null;
  complete: boolean;
  expected: number;
  copied: number;
  skippedIdentical: number;
  verifiedAtDestination: number;
  missingAtSource: string[];
  failedAtDestination: string[];
  applied: boolean;
}

/**
 * Two-phase, fail-closed, atomic media backup.
 *
 * Phase A — completeness scan: every DB-referenced object is read + hashed.
 *   Any missing/unreadable source object ⇒ `complete:false`, NO inventory,
 *   NO commit marker (nothing is copied in apply mode).
 * Phase B — copy + commit (apply only): copy each object (idempotent: an
 *   already-identical destination object is skipped), re-read + hash-check
 *   EVERY destination object, then publish the authenticated inventory LAST
 *   (to `media/<stamp>/inventory.json`) as the commit marker. Any destination
 *   verification failure ⇒ `complete:false`, NO inventory published.
 *
 * Dry run (default): Phase A only — reports completeness and the would-be
 * inventory WITHOUT writing anything. A dry-run inventory is returned for
 * inspection only when the set is complete.
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
  const expected = keys.length;

  // Phase A: completeness scan (read + hash every source object).
  const entries: MediaInventoryEntry[] = [];
  const sourceBlobs = new Map<string, Buffer>();
  const missingAtSource: string[] = [];
  for (const key of keys) {
    let blob: Buffer | null = null;
    try {
      blob = await opts.source.store.get(key);
    } catch {
      blob = null; // unreadable === missing for completeness purposes
    }
    if (!blob) {
      missingAtSource.push(key);
      continue;
    }
    sourceBlobs.set(key, blob);
    entries.push({ key, bytes: blob.length, sha256: sha256(blob) });
  }
  if (missingAtSource.length > 0) {
    // Fail BEFORE copying; publish nothing, produce no commit marker.
    return {
      inventory: null,
      complete: false,
      expected,
      copied: 0,
      skippedIdentical: 0,
      verifiedAtDestination: 0,
      missingAtSource,
      failedAtDestination: [],
      applied: false,
    };
  }

  const buildInventory = (): MediaInventory => {
    const body: MediaInventoryBody = {
      format_version: 2,
      kind: "media-s3-inventory",
      stamp: opts.stamp,
      created_at: opts.createdAt,
      source_role: "primary-media",
      destination_role: "media-backup",
      backup_prefix: prefix,
      source_fingerprint: fingerprint(opts.source.identity),
      expected_object_count: expected,
      object_count: entries.length,
      total_bytes: entries.reduce((n, o) => n + o.bytes, 0),
      completeness: "complete",
      objects: entries,
      notes: [
        "Objects are AES-256-GCM ciphertext copied AS STORED — never decrypted.",
        "NOVA_ENCRYPTION_KEY is NOT in this backup; restore recovers ciphertext",
        "that still requires the data key. Inventory MAC uses NOVA_BACKUP_KEY.",
        "Published LAST as the backup-set commit marker (M18A.1).",
      ],
    };
    return { ...body, mac: inventoryMac(body, opts.backupKey) };
  };

  if (!opts.apply) {
    // Dry run: complete set confirmed, but write nothing.
    return {
      inventory: buildInventory(),
      complete: true,
      expected,
      copied: 0,
      skippedIdentical: 0,
      verifiedAtDestination: 0,
      missingAtSource: [],
      failedAtDestination: [],
      applied: false,
    };
  }

  // Phase B: copy (idempotent), then verify EVERY destination object.
  let copied = 0;
  let skippedIdentical = 0;
  for (const entry of entries) {
    const destKey = `${prefix}${entry.key}`;
    const existing = await opts.backup.store.get(destKey);
    if (existing && sha256(existing) === entry.sha256) {
      skippedIdentical += 1; // resumable/idempotent re-run
      continue;
    }
    await opts.backup.store.put(destKey, sourceBlobs.get(entry.key)!);
    copied += 1;
  }
  const failedAtDestination: string[] = [];
  let verifiedAtDestination = 0;
  for (const entry of entries) {
    const written = await opts.backup.store.get(`${prefix}${entry.key}`);
    if (!written || written.length !== entry.bytes || sha256(written) !== entry.sha256) {
      failedAtDestination.push(entry.key);
    } else {
      verifiedAtDestination += 1;
    }
  }
  if (failedAtDestination.length > 0) {
    // Do NOT publish the commit marker; the backup is not trustworthy.
    return {
      inventory: null,
      complete: false,
      expected,
      copied,
      skippedIdentical,
      verifiedAtDestination,
      missingAtSource: [],
      failedAtDestination,
      applied: true,
    };
  }

  // Commit: publish the authenticated inventory LAST.
  const inventory = buildInventory();
  await opts.backup.store.put(
    `${prefix}inventory.json`,
    Buffer.from(JSON.stringify(inventory, null, 2)),
  );
  return {
    inventory,
    complete: true,
    expected,
    copied,
    skippedIdentical,
    verifiedAtDestination,
    missingAtSource: [],
    failedAtDestination: [],
    applied: true,
  };
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
  if (inv.format_version !== 2 || inv.kind !== "media-s3-inventory") return "unexpected header";
  if (typeof inv.stamp !== "string" || typeof inv.created_at !== "string") return "bad header";
  if (typeof inv.mac !== "string" || !/^[0-9a-f]{64}$/.test(inv.mac)) return "missing/invalid mac";
  if (typeof inv.backup_prefix !== "string" || typeof inv.source_fingerprint !== "string")
    return "bad target metadata";
  if (inv.completeness !== "complete") return "inventory is not marked complete";
  if (typeof inv.expected_object_count !== "number") return "missing expected_object_count";
  if (!Array.isArray(inv.objects)) return "bad objects";
  for (const o of inv.objects) {
    if (typeof o.key !== "string" || typeof o.bytes !== "number" || o.bytes < 0) return "bad entry";
    if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256)) return "bad entry sha256";
  }
  if (inv.object_count !== inv.objects.length) return "object_count mismatch";
  if (inv.expected_object_count !== inv.object_count) return "expected/actual count mismatch (incomplete)";
  return null;
}

export interface VerifyBackupResult {
  ok: boolean;
  manifest: { shape: "ok" | "invalid"; mac: "ok" | "mismatch"; detail?: string };
  expected: number;
  objectCount: number;
  verified: number;
  missing: number;
  altered: number;
}

/** Authenticate the inventory (fail closed on wrong key/tamper/incomplete),
 * then prove every entry exists in the backup store with the recorded size +
 * sha256. Read-only; never decrypts; reports counts only. */
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
      expected: inv.expected_object_count ?? 0,
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
      expected: inv.expected_object_count,
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
    ok: missing === 0 && altered === 0 && verified === inv.expected_object_count,
    manifest: { shape: "ok", mac: "ok" },
    expected: inv.expected_object_count,
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
