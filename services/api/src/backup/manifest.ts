import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDecryptable, hashesEqual, sha256File } from "./crypto.js";

/**
 * M15 (Hermes P1): backup manifest. Records, for each sealed artifact, its
 * sha256 (of the CIPHERTEXT — integrity checkable without the key), byte
 * size, and role, plus a UTC timestamp and a format version. No secrets,
 * no key material, no plaintext content. `backup:verify` recomputes the
 * hashes and (with the key) confirms each artifact still decrypts.
 */

export interface ManifestArtifact {
  name: string; // filename within the backup dir
  role: "postgres" | "media";
  sha256: string; // over the sealed (encrypted) bytes
  bytes: number; // sealed size
}

export interface BackupManifest {
  format_version: 1;
  created_at: string;
  stamp: string;
  encryption: "aes-256-gcm";
  artifacts: ManifestArtifact[];
  notes: string[];
}

export function manifestPath(dir: string, stamp: string): string {
  return join(dir, `manifest-${stamp}.json`);
}

export async function buildManifest(
  dir: string,
  stamp: string,
  createdAt: string,
  artifacts: Array<{ name: string; role: ManifestArtifact["role"] }>,
): Promise<BackupManifest> {
  const entries: ManifestArtifact[] = [];
  for (const a of artifacts) {
    const p = join(dir, a.name);
    const s = await stat(p);
    entries.push({ name: a.name, role: a.role, sha256: await sha256File(p), bytes: s.size });
  }
  return {
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

export interface VerifyResult {
  ok: boolean;
  checks: Array<{ artifact: string; hash: "ok" | "mismatch" | "missing"; decrypt?: "ok" | "fail" }>;
}

/**
 * Verify a backup: recompute each artifact's sha256 against the manifest
 * (catches tampering / corruption WITHOUT the key), and — when a key is
 * supplied — confirm each artifact actually decrypts (auth tag valid).
 */
export async function verifyBackup(
  dir: string,
  stamp: string,
  key: Buffer | null,
): Promise<VerifyResult> {
  const manifest = await readManifest(dir, stamp);
  const checks: VerifyResult["checks"] = [];
  let ok = true;
  for (const a of manifest.artifacts) {
    const p = join(dir, a.name);
    let hash: "ok" | "mismatch" | "missing";
    try {
      const actual = await sha256File(p);
      hash = hashesEqual(actual, a.sha256) ? "ok" : "mismatch";
    } catch {
      hash = "missing";
    }
    if (hash !== "ok") ok = false;
    const check: VerifyResult["checks"][number] = { artifact: a.name, hash };
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
  return { ok, checks };
}
