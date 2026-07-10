import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { encryptFile, parseBackupKey } from "./crypto.js";
import { buildManifest, writeManifest, type ManifestArtifact } from "./manifest.js";

/**
 * M15 operator step (invoked by scripts/backup.sh): seal freshly-created
 * plaintext backup artifacts with AES-256-GCM (NOVA_BACKUP_KEY), delete the
 * plaintext, and write a signed manifest. Fails closed if the key is absent
 * — there is NO plaintext-backup path. Prints no secrets.
 *
 *   backup:seal -- --dir=<backup-dir> --stamp=<stamp> [--created-at=<iso>]
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const dir = arg("dir");
  const stamp = arg("stamp");
  const createdAt = arg("created-at") ?? new Date().toISOString();
  if (!dir || !stamp) {
    throw new Error("usage: backup:seal -- --dir=<dir> --stamp=<stamp>");
  }
  let key: Buffer;
  try {
    key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  } catch (err) {
    throw new Error(
      `${(err as Error).message}. Backups are always encrypted — set NOVA_BACKUP_KEY ` +
        "(a SEPARATE 32-byte key from NOVA_ENCRYPTION_KEY, kept in your secret store).",
    );
  }

  const candidates: Array<{ plain: string; role: ManifestArtifact["role"] }> = [
    { plain: `nova-db-${stamp}.dump`, role: "postgres" },
    { plain: `nova-media-${stamp}.tar.gz`, role: "media" },
  ];
  const sealed: Array<{ name: string; role: ManifestArtifact["role"] }> = [];
  for (const c of candidates) {
    const plainPath = join(dir, c.plain);
    try {
      await stat(plainPath);
    } catch {
      continue; // artifact not produced (e.g. s3 media) — skip
    }
    const encName = `${c.plain}.enc`;
    await encryptFile(plainPath, join(dir, encName), key);
    await unlink(plainPath); // no plaintext artifact survives
    sealed.push({ name: encName, role: c.role });
    console.log(`  sealed ${c.plain} → ${encName}`);
  }
  if (!sealed.length) throw new Error(`no backup artifacts found in ${dir} for stamp ${stamp}`);

  const manifest = await buildManifest(dir, stamp, createdAt, sealed);
  const manifestFile = await writeManifest(dir, manifest);
  console.log(`  wrote ${manifestFile.split("/").pop()} (${sealed.length} artifact(s), sha256 recorded)`);
}

main().catch((err) => {
  console.error("backup:seal failed:", (err as Error).message);
  process.exit(1);
});
