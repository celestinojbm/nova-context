import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { encryptFile, parseBackupKey } from "./crypto.js";
import { buildManifest, writeManifest, type ManifestArtifact } from "./manifest.js";

/**
 * M15 operator step (invoked by scripts/backup.sh): seal plaintext backup
 * artifacts with AES-256-GCM (NOVA_BACKUP_KEY) and write a signed manifest.
 * Fails closed if the key is absent — there is NO plaintext-backup path.
 * Prints no secrets.
 *
 * M15B (Hermes D02): plaintext lives ONLY in a private temp `--work` dir; the
 * sealed `.enc` + manifest are written to `--out`. The caller (backup.sh)
 * publishes `--out` only after this succeeds, and a shell trap wipes
 * `--work` on any failure — so the final backup dir never holds plaintext.
 *
 * M15C (Hermes M15B-R02): `--work` and `--out` are BOTH required and MUST be
 * distinct directories. The old `--dir` alias (and the `out = work` default)
 * allowed sealing in place — plaintext and ciphertext in the same directory —
 * which defeats the D02 guarantee if a caller invoked this tool directly.
 * That unsafe mode is now rejected.
 *
 * M16 (Hermes M15C accepted-P2 hardening): the distinctness check now compares
 * the **physical** directories via `realpath()` (symlinks resolved), not a
 * lexical `resolve()`. A prior lexical check could be defeated by making
 * `--out` a symlink to `--work` (different spellings, same directory), sealing
 * in place. Physical comparison catches that. `scripts/backup.sh` remains the
 * only documented operator path (it passes a private mktemp `--work` and a
 * SEPARATE `--out` nested under it, which realpath-resolves distinctly).
 *
 *   backup:seal -- --work=<plaintext-dir> --out=<sealed-dir> --stamp=<stamp>
 *                  [--created-at=<iso>]
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const work = arg("work");
  const out = arg("out");
  const stamp = arg("stamp");
  const createdAt = arg("created-at") ?? new Date().toISOString();
  if (arg("dir") !== undefined) {
    throw new Error(
      "backup:seal no longer accepts --dir (unsafe in-place sealing). " +
        "Pass a private plaintext --work dir and a SEPARATE sealed --out dir.",
    );
  }
  if (!work || !out || !stamp) {
    throw new Error("usage: backup:seal -- --work=<dir> --out=<dir> --stamp=<stamp>");
  }
  // Physical-path distinctness (symlinks resolved). `--work` must already
  // exist (it holds the plaintext); create `--out` first so realpath resolves.
  await mkdir(out, { recursive: true, mode: 0o700 });
  let workReal: string;
  let outReal: string;
  try {
    workReal = await realpath(work);
  } catch {
    throw new Error(`backup:seal: --work dir does not exist: ${work}`);
  }
  outReal = await realpath(out);
  if (workReal === outReal) {
    throw new Error(
      "backup:seal refuses --work === --out (physical path, symlinks resolved): " +
        "plaintext and sealed artifacts must never share a directory " +
        "(Hermes M15B-R02 / M16). Use a separate --out dir.",
    );
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
    const plainPath = join(work, c.plain);
    try {
      await stat(plainPath);
    } catch {
      continue; // artifact not produced (e.g. s3 media) — skip
    }
    const encName = `${c.plain}.enc`;
    // Encrypt from the private work dir INTO the sealed out dir. The plaintext
    // in work is wiped by the caller's trap; nothing plaintext reaches out.
    await encryptFile(plainPath, join(out, encName), key);
    await unlink(plainPath).catch(() => undefined);
    sealed.push({ name: encName, role: c.role });
    console.log(`  sealed ${c.plain} → ${encName}`);
  }
  if (!sealed.length) throw new Error(`no backup artifacts found for stamp ${stamp}`);

  const manifest = await buildManifest(out, stamp, createdAt, sealed, key);
  const manifestFile = await writeManifest(out, manifest);
  console.log(`  wrote ${manifestFile.split("/").pop()} (${sealed.length} artifact(s), sha256 recorded)`);
}

main().catch((err) => {
  console.error("backup:seal failed:", (err as Error).message);
  process.exit(1);
});
