import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectStore } from "../media/object-store.js";
import { hashesEqual, sha256File } from "./crypto.js";
import { readManifest, verifyBackup, type BackupManifest } from "./manifest.js";

/**
 * M18A.2 §3: publish/fetch a COMPLETE sealed backup set to an S3-compatible
 * store, so a Render one-off job (whose local filesystem is ephemeral) can
 * survive job teardown and a recovery job can fetch a committed set.
 *
 * This is a THIN extension of the existing sealed-backup framework — it copies
 * the artifacts backup.sh already sealed (encrypted DB dump, optional encrypted
 * media tar, the authenticated sealed manifest, and the S3 media inventory when
 * present) to a PRIVATE remote prefix, and binds them with an authenticated
 * commit marker. It never re-seals, never decrypts, and never uploads plaintext.
 *
 * Layout (a private, per-stamp prefix):
 *   sealed-backups/<stamp>/<artifact>          — every sealed artifact
 *   sealed-backups/<stamp>/remote-marker.json  — published LAST (the commit)
 *
 * The remote marker is HMAC-SHA256 authenticated with NOVA_BACKUP_KEY and binds
 * the stamp, every artifact name + ciphertext sha256 + size, the sealed-manifest
 * hash, the media-inventory hash (when applicable), the expected artifact count,
 * completeness, creation time, and source/destination roles. Without a valid
 * marker a partial upload is NEVER a valid backup.
 */

export const REMOTE_MARKER_NAME = "remote-marker.json";

export type SealedRole = "postgres" | "media" | "manifest" | "media-inventory";

export interface SealedArtifactEntry {
  name: string;
  role: SealedRole;
  sha256: string; // over the bytes AS STORED (ciphertext for .enc; json for the rest)
  bytes: number;
}

export interface SealedRemoteMarkerBody {
  format_version: 1;
  kind: "sealed-backup-remote-marker";
  stamp: string;
  created_at: string;
  artifacts: SealedArtifactEntry[];
  sealed_manifest_sha256: string;
  media_inventory_sha256: string | null;
  expected_artifact_count: number;
  completeness: "complete";
  source_role: "local-sealed-backup-dir";
  destination_role: "remote-sealed-backup-store";
}

export interface SealedRemoteMarker extends SealedRemoteMarkerBody {
  mac: string;
}

/** A safe per-stamp prefix. The stamp is validated (no slashes / traversal) so
 * a caller-supplied value can never escape the `sealed-backups/` namespace. */
export function remotePrefixFor(stamp: string): string {
  assertSafeStamp(stamp);
  return `sealed-backups/${stamp}/`;
}

export function assertSafeStamp(stamp: string): void {
  if (!stamp || !/^[0-9A-Za-z._-]+$/.test(stamp) || stamp === "." || stamp === "..") {
    throw new Error("unsafe backup stamp (must match [0-9A-Za-z._-], no path separators)");
  }
}

/** Canonical, stable serialization of the marker body for MAC/verify. */
function canonicalMarker(body: SealedRemoteMarkerBody): string {
  return JSON.stringify({
    artifacts: body.artifacts
      .map((a) => ({ bytes: a.bytes, name: a.name, role: a.role, sha256: a.sha256 }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    completeness: body.completeness,
    created_at: body.created_at,
    destination_role: body.destination_role,
    expected_artifact_count: body.expected_artifact_count,
    format_version: body.format_version,
    kind: body.kind,
    media_inventory_sha256: body.media_inventory_sha256,
    sealed_manifest_sha256: body.sealed_manifest_sha256,
    source_role: body.source_role,
    stamp: body.stamp,
  });
}

export function markerMac(body: SealedRemoteMarkerBody, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalMarker(body)).digest("hex");
}

function macMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const MANIFEST_NAME = (stamp: string) => `manifest-${stamp}.json`;
const MEDIA_INVENTORY_NAME = (stamp: string) => `media-inventory-${stamp}.json`;

/** Enumerate the local sealed set from the authenticated manifest: every
 * sealed .enc artifact (postgres/media), the manifest itself, and the S3 media
 * inventory when it is present next to the manifest. */
async function localArtifacts(
  dir: string,
  stamp: string,
  manifest: BackupManifest,
): Promise<{ entries: SealedArtifactEntry[]; mediaInventoryPresent: boolean }> {
  const entries: SealedArtifactEntry[] = [];
  for (const a of manifest.artifacts) {
    const p = join(dir, a.name);
    const s = await stat(p);
    entries.push({ name: a.name, role: a.role, sha256: await sha256File(p), bytes: s.size });
  }
  const manifestName = MANIFEST_NAME(stamp);
  const mp = join(dir, manifestName);
  const ms = await stat(mp);
  entries.push({ name: manifestName, role: "manifest", sha256: await sha256File(mp), bytes: ms.size });

  let mediaInventoryPresent = false;
  const invName = MEDIA_INVENTORY_NAME(stamp);
  try {
    const ip = join(dir, invName);
    const is = await stat(ip);
    entries.push({ name: invName, role: "media-inventory", sha256: await sha256File(ip), bytes: is.size });
    mediaInventoryPresent = true;
  } catch {
    // no s3 media inventory for this backup (fs-media or db-only) — fine.
  }
  return { entries, mediaInventoryPresent };
}

export interface PublishSealedResult {
  marker: SealedRemoteMarker | null;
  applied: boolean;
  uploaded: string[];
  expected: number;
  verifiedAtDestination: number;
}

/**
 * Publish the sealed backup set. Fail-closed and atomic:
 *   1. verify the LOCAL sealed backup (manifest MAC + per-artifact hashes +
 *      decryptability) BEFORE any upload;
 *   2. dry-run by default — with --apply=false NOTHING is written, only the
 *      would-be marker + counts are returned;
 *   3. upload every artifact, then RE-READ and hash each destination object;
 *   4. publish the authenticated marker LAST as the sole commit marker.
 * A missing/altered destination object aborts before the marker is written, so
 * a partial upload never looks complete. Re-runs are idempotent (same keys).
 */
export async function publishSealedBackup(opts: {
  dir: string;
  stamp: string;
  store: ObjectStore;
  backupKey: Buffer;
  createdAt: string;
  apply: boolean;
}): Promise<PublishSealedResult> {
  const { dir, stamp, store, backupKey, createdAt, apply } = opts;
  assertSafeStamp(stamp);
  const prefix = remotePrefixFor(stamp);

  // Verify the LOCAL sealed backup BEFORE any upload (manifest MAC + per-
  // artifact ciphertext hashes + decryptability). Never publish a set that
  // does not verify locally.
  const localVerify = await verifyBackup(dir, stamp, backupKey);
  if (!localVerify.ok) {
    throw new Error(
      "refusing to publish: the LOCAL sealed backup failed verification " +
        `(manifest shape:${localVerify.manifest.shape} mac:${localVerify.manifest.mac}) — nothing uploaded`,
    );
  }

  const manifest = await readManifest(dir, stamp);
  const { entries, mediaInventoryPresent } = await localArtifacts(dir, stamp, manifest);
  const manifestEntry = entries.find((e) => e.role === "manifest")!;
  const invEntry = entries.find((e) => e.role === "media-inventory") ?? null;

  const body: SealedRemoteMarkerBody = {
    format_version: 1,
    kind: "sealed-backup-remote-marker",
    stamp,
    created_at: createdAt,
    artifacts: entries,
    sealed_manifest_sha256: manifestEntry.sha256,
    media_inventory_sha256: mediaInventoryPresent ? invEntry!.sha256 : null,
    expected_artifact_count: entries.length,
    completeness: "complete",
    source_role: "local-sealed-backup-dir",
    destination_role: "remote-sealed-backup-store",
  };
  const marker: SealedRemoteMarker = { ...body, mac: markerMac(body, backupKey) };

  if (!apply) {
    return { marker, applied: false, uploaded: [], expected: entries.length, verifiedAtDestination: 0 };
  }

  // Upload each artifact, then re-read + verify at the destination.
  const uploaded: string[] = [];
  let verifiedAtDestination = 0;
  for (const a of entries) {
    const bytes = await readFile(join(dir, a.name));
    await store.put(`${prefix}${a.name}`, bytes);
    uploaded.push(a.name);
    const readBack = await store.get(`${prefix}${a.name}`);
    if (!readBack || sha256Buffer(readBack) !== a.sha256 || readBack.length !== a.bytes) {
      throw new Error(
        `sealed-backup publish INCOMPLETE: destination object ${a.name} failed re-verification — marker NOT written`,
      );
    }
    verifiedAtDestination++;
  }

  // Commit marker LAST.
  await store.put(`${prefix}${REMOTE_MARKER_NAME}`, Buffer.from(JSON.stringify(marker, null, 2)));
  uploaded.push(REMOTE_MARKER_NAME);
  return { marker, applied: true, uploaded, expected: entries.length, verifiedAtDestination };
}

const VALID_ROLES = new Set<SealedRole>(["postgres", "media", "manifest", "media-inventory"]);

function validateMarkerShape(m: SealedRemoteMarker): string | null {
  if (m.format_version !== 1 || m.kind !== "sealed-backup-remote-marker") return "unexpected header";
  if (typeof m.stamp !== "string" || typeof m.created_at !== "string") return "bad header";
  if (m.completeness !== "complete") return "incomplete marker";
  if (typeof m.mac !== "string" || !/^[0-9a-f]{64}$/.test(m.mac)) return "missing/invalid mac";
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) return "no artifacts";
  if (m.expected_artifact_count !== m.artifacts.length) return "artifact count mismatch";
  for (const a of m.artifacts) {
    if (typeof a.name !== "string" || !VALID_ROLES.has(a.role)) return "bad artifact entry";
    if (typeof a.bytes !== "number" || a.bytes < 0) return "bad artifact bytes";
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) return "bad artifact sha256";
  }
  if (!m.artifacts.some((a) => a.role === "postgres")) return "missing required postgres artifact";
  if (!m.artifacts.some((a) => a.role === "manifest")) return "missing sealed manifest";
  const manifestEntry = m.artifacts.find((a) => a.role === "manifest");
  if (manifestEntry && manifestEntry.sha256 !== m.sealed_manifest_sha256) return "sealed_manifest_sha256 mismatch";
  return null;
}

export interface VerifyRemoteResult {
  ok: boolean;
  marker: { shape: "ok" | "invalid" | "missing"; mac: "ok" | "mismatch" | "no_key"; detail?: string };
  expected: number;
  verified: number;
  missing: string[];
  altered: string[];
}

/** Read the remote marker, authenticate its HMAC, then verify every artifact
 * object's ciphertext hash + size. Fail-closed: a missing/altered object, a
 * wrong/absent key, or a shape/count problem makes ok=false. */
export async function verifySealedBackupRemote(opts: {
  store: ObjectStore;
  stamp: string;
  backupKey: Buffer | null;
}): Promise<VerifyRemoteResult> {
  const { store, stamp, backupKey } = opts;
  const prefix = remotePrefixFor(stamp);
  const raw = await store.get(`${prefix}${REMOTE_MARKER_NAME}`);
  if (!raw) {
    return { ok: false, marker: { shape: "missing", mac: "no_key", detail: "no committed marker" }, expected: 0, verified: 0, missing: [REMOTE_MARKER_NAME], altered: [] };
  }
  let m: SealedRemoteMarker;
  try {
    m = JSON.parse(raw.toString("utf8")) as SealedRemoteMarker;
  } catch {
    return { ok: false, marker: { shape: "invalid", mac: "no_key", detail: "marker not JSON" }, expected: 0, verified: 0, missing: [], altered: [REMOTE_MARKER_NAME] };
  }
  const shapeError = validateMarkerShape(m);
  const result: VerifyRemoteResult = {
    ok: !shapeError,
    marker: { shape: shapeError ? "invalid" : "ok", mac: "no_key", ...(shapeError ? { detail: shapeError } : {}) },
    expected: Array.isArray(m.artifacts) ? m.artifacts.length : 0,
    verified: 0,
    missing: [],
    altered: [],
  };
  if (backupKey) {
    const { mac, ...bodyRest } = m;
    result.marker.mac = macMatches(markerMac(bodyRest as SealedRemoteMarkerBody, backupKey), mac ?? "") ? "ok" : "mismatch";
    if (result.marker.mac !== "ok") result.ok = false;
  } else {
    result.ok = false; // unauthenticated marker is never trusted
  }
  if (shapeError) return result;

  for (const a of m.artifacts) {
    const buf = await store.get(`${prefix}${a.name}`);
    if (!buf) {
      result.missing.push(a.name);
      result.ok = false;
      continue;
    }
    if (buf.length !== a.bytes || !hashesEqual(sha256Buffer(buf), a.sha256)) {
      result.altered.push(a.name);
      result.ok = false;
      continue;
    }
    result.verified++;
  }
  return result;
}

export interface FetchSealedResult {
  ok: boolean;
  files: string[];
  verified: number;
  expected: number;
}

/**
 * Fetch a COMMITTED sealed backup set into `destDir`. Verifies the remote
 * marker (auth + object hashes) FIRST and fails before downloading if the set
 * is not committed/valid. Then downloads each artifact, re-verifying its hash +
 * size on the way in. The CALLER is responsible for making `destDir` a private
 * 0700 temp dir and removing it on exit (see run-backup-fetch-s3.ts).
 */
export async function fetchSealedBackup(opts: {
  store: ObjectStore;
  stamp: string;
  backupKey: Buffer;
  destDir: string;
}): Promise<FetchSealedResult> {
  const { store, stamp, backupKey, destDir } = opts;
  const prefix = remotePrefixFor(stamp);
  const verify = await verifySealedBackupRemote({ store, stamp, backupKey });
  if (!verify.ok) {
    throw new Error(
      `refusing to fetch: remote sealed backup ${stamp} is not a committed, authenticated, intact set ` +
        `(marker shape:${verify.marker.shape} mac:${verify.marker.mac}, missing:${verify.missing.length}, altered:${verify.altered.length})`,
    );
  }
  const raw = await store.get(`${prefix}${REMOTE_MARKER_NAME}`);
  const m = JSON.parse(raw!.toString("utf8")) as SealedRemoteMarker;
  const files: string[] = [];
  let verified = 0;
  for (const a of m.artifacts) {
    const buf = await store.get(`${prefix}${a.name}`);
    if (!buf || buf.length !== a.bytes || !hashesEqual(sha256Buffer(buf), a.sha256)) {
      throw new Error(`fetched object ${a.name} failed hash/size verification — aborting before restore`);
    }
    await writeFile(join(destDir, a.name), buf, { mode: 0o600 });
    files.push(a.name);
    verified++;
  }
  // Also drop the marker locally (informational; not required by backup:verify).
  await writeFile(join(destDir, REMOTE_MARKER_NAME), raw!, { mode: 0o600 });
  return { ok: true, files, verified, expected: m.artifacts.length };
}
