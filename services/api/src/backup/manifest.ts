import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDecryptable, hashesEqual, sha256File } from "./crypto.js";

/**
 * M15 (Hermes P1): backup manifest. Records, for each sealed artifact, its
 * sha256 (of the CIPHERTEXT — integrity checkable without the key), byte
 * size, and role, plus a UTC timestamp and a format version. No secrets,
 * no key material, no plaintext content.
 *
 * M15B (Hermes D04): the manifest is now AUTHENTICATED. An HMAC-SHA256 over
 * the canonical manifest body (using NOVA_BACKUP_KEY) is stored in `mac`,
 * so tampering with ANY field — size, timestamp, role, artifact list — is
 * detected, not just a raw file-hash mismatch. `backup:verify` also
 * re-checks each artifact's recorded byte size against the file on disk and
 * confirms the required `postgres` role is present.
 */

export interface ManifestArtifact {
  name: string; // filename within the backup dir
  role: "postgres" | "media";
  sha256: string; // over the sealed (encrypted) bytes
  bytes: number; // sealed size
}

export interface BackupManifestBody {
  format_version: 1;
  created_at: string;
  stamp: string;
  encryption: "aes-256-gcm";
  artifacts: ManifestArtifact[];
  notes: string[];
}

export interface BackupManifest extends BackupManifestBody {
  /** M15B (D04): HMAC-SHA256 of the canonical body, keyed with NOVA_BACKUP_KEY. */
  mac: string;
}

export function manifestPath(dir: string, stamp: string): string {
  return join(dir, `manifest-${stamp}.json`);
}

/** Canonical, stable serialization of the manifest body for MAC/verify.
 * Sorted keys so a re-serialization always yields the same bytes. */
function canonicalBody(body: BackupManifestBody): string {
  return JSON.stringify({
    artifacts: body.artifacts
      .map((a) => ({ bytes: a.bytes, name: a.name, role: a.role, sha256: a.sha256 }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    created_at: body.created_at,
    encryption: body.encryption,
    format_version: body.format_version,
    notes: body.notes,
    stamp: body.stamp,
  });
}

export function manifestMac(body: BackupManifestBody, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalBody(body)).digest("hex");
}

export async function buildManifest(
  dir: string,
  stamp: string,
  createdAt: string,
  artifacts: Array<{ name: string; role: ManifestArtifact["role"] }>,
  key: Buffer,
): Promise<BackupManifest> {
  const entries: ManifestArtifact[] = [];
  for (const a of artifacts) {
    const p = join(dir, a.name);
    const s = await stat(p);
    entries.push({ name: a.name, role: a.role, sha256: await sha256File(p), bytes: s.size });
  }
  const body: BackupManifestBody = {
    format_version: 1,
    created_at: createdAt,
    stamp,
    encryption: "aes-256-gcm",
    artifacts: entries,
    notes: [
      "Artifacts are AES-256-GCM sealed with NOVA_BACKUP_KEY (NOT in this backup).",
      "Restore recovers metadata + sealed blobs; NOVA_ENCRYPTION_KEY is still",
      "required to read media/tokens. Redis/queues are not backed up.",
    ],
  };
  return { ...body, mac: manifestMac(body, key) };
}

export async function writeManifest(
  dir: string,
  manifest: BackupManifest,
): Promise<string> {
  const p = manifestPath(dir, manifest.stamp);
  await writeFile(p, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return p;
}

export async function readManifest(dir: string, stamp: string): Promise<BackupManifest> {
  const raw = await readFile(manifestPath(dir, stamp), "utf8");
  return JSON.parse(raw) as BackupManifest;
}

const VALID_ROLES = new Set(["postgres", "media"]);

/** Structural validation of a parsed manifest (D04): shape + required role. */
function validateManifestShape(m: BackupManifest): string | null {
  if (m.format_version !== 1) return "unexpected format_version";
  if (typeof m.stamp !== "string" || typeof m.created_at !== "string") return "bad header";
  if (m.encryption !== "aes-256-gcm") return "unexpected encryption";
  if (typeof m.mac !== "string" || !/^[0-9a-f]{64}$/.test(m.mac)) return "missing/invalid mac";
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) return "no artifacts";
  for (const a of m.artifacts) {
    if (typeof a.name !== "string" || !VALID_ROLES.has(a.role)) return "bad artifact entry";
    if (typeof a.bytes !== "number" || a.bytes < 0) return "bad artifact bytes";
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) return "bad artifact sha256";
  }
  if (!m.artifacts.some((a) => a.role === "postgres")) return "missing required postgres artifact";
  return null;
}

function macMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface VerifyResult {
  ok: boolean;
  /** M15B (D04): manifest-level checks (before per-artifact file checks). */
  manifest: { shape: "ok" | "invalid"; mac: "ok" | "mismatch" | "no_key"; detail?: string };
  checks: Array<{
    artifact: string;
    hash: "ok" | "mismatch" | "missing";
    size: "ok" | "mismatch" | "unknown";
    decrypt?: "ok" | "fail";
  }>;
}

/**
 * Verify a backup:
 *   - manifest shape (D04): required fields, roles, a `postgres` artifact;
 *   - manifest MAC (D04): HMAC-SHA256 with NOVA_BACKUP_KEY — catches ANY
 *     metadata tampering (size/timestamp/role/artifact list). Needs the key;
 *   - per-artifact sha256 of the ciphertext (integrity WITHOUT the key);
 *   - per-artifact recorded byte size vs the file on disk;
 *   - per-artifact decryptability (auth tag) when the key is supplied.
 * ok is true only when every applicable check passes.
 */
export async function verifyBackup(
  dir: string,
  stamp: string,
  key: Buffer | null,
): Promise<VerifyResult> {
  const manifest = await readManifest(dir, stamp);
  const shapeError = validateManifestShape(manifest);
  const manifestResult: VerifyResult["manifest"] = {
    shape: shapeError ? "invalid" : "ok",
    mac: "no_key",
    ...(shapeError ? { detail: shapeError } : {}),
  };
  let ok = !shapeError;

  if (key) {
    const { mac, ...body } = manifest;
    const expected = manifestMac(body, key);
    manifestResult.mac = macMatches(expected, mac ?? "") ? "ok" : "mismatch";
    if (manifestResult.mac !== "ok") ok = false;
  }

  const checks: VerifyResult["checks"] = [];
  for (const a of manifest.artifacts) {
    const p = join(dir, a.name);
    let hash: "ok" | "mismatch" | "missing";
    let size: "ok" | "mismatch" | "unknown";
    try {
      const s = await stat(p);
      size = s.size === a.bytes ? "ok" : "mismatch";
      const actual = await sha256File(p);
      hash = hashesEqual(actual, a.sha256) ? "ok" : "mismatch";
    } catch {
      hash = "missing";
      size = "unknown";
    }
    if (hash !== "ok" || size !== "ok") ok = false;
    const check: VerifyResult["checks"][number] = { artifact: a.name, hash, size };
    if (key && hash === "ok") {
      try {
        await assertDecryptable(p, key);
        check.decrypt = "ok";
      } catch {
        check.decrypt = "fail";
        ok = false;
      }
    }
    checks.push(check);
  }
  return { ok, manifest: manifestResult, checks };
}
