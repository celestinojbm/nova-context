import pg from "pg";
import { loadEnv } from "../env.js";
import { parseBackupKey } from "./crypto.js";
import { backupTarget, primaryTarget } from "./media-s3-env.js";
import { backupMediaToStore, writeInventoryFile, type MediaKeyRow } from "./media-s3.js";

/**
 * M18A operator command: back up DB-referenced encrypted media blobs from the
 * primary object store into a SEPARATE backup store (S3-compatible: MinIO
 * locally, R2 in production), with an HMAC-authenticated inventory.
 *
 *   media:backup-s3 -- --stamp=<stamp> --out=<dir> [--apply]
 *
 * Dry-run by default: enumerates + hashes, writes NOTHING. `--apply` copies
 * (idempotently) and writes the inventory both to --out (next to the sealed
 * DB backup) and into the backup store. Blobs are ciphertext copied AS
 * STORED — never decrypted. Output prints counts only: no object keys, no
 * content, no secrets.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const stamp = arg("stamp");
  const out = arg("out");
  if (!stamp || !out) {
    throw new Error("usage: media:backup-s3 -- --stamp=<stamp> --out=<dir> [--apply]");
  }
  const apply = has("apply");
  const env = loadEnv();
  const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  const source = await primaryTarget(env);
  const backup = backupTarget(env, process.env);

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
  const { rows } = await pool.query<MediaKeyRow>(
    `SELECT storage_key, thumb_key FROM moment_media ORDER BY created_at ASC`,
  );
  await pool.end();

  const res = await backupMediaToStore({
    rows,
    source,
    backup,
    stamp,
    createdAt: new Date().toISOString(),
    backupKey: key,
    apply,
  });

  console.log(`media backup (${apply ? "APPLIED" : "DRY RUN — pass --apply to copy"}):`);
  console.log(`  expected objects:   ${res.expected}`);
  console.log(`  copied:             ${res.copied}`);
  console.log(`  already identical:  ${res.skippedIdentical}`);
  console.log(`  verified at dest:   ${res.verifiedAtDestination}`);
  console.log(`  missing at source:  ${res.missingAtSource.length}`);
  console.log(`  failed at dest:     ${res.failedAtDestination.length}`);

  if (!res.complete || !res.inventory) {
    // Fail closed: no commit marker, no completion. An incomplete set must
    // never be recognized as a backup.
    if (res.missingAtSource.length > 0) {
      console.error("  ERROR: database references objects the primary store does not hold — NO inventory published.");
    } else if (res.failedAtDestination.length > 0) {
      console.error("  ERROR: destination verification failed — NO inventory published (backup NOT committed).");
    } else {
      console.error("  ERROR: media backup incomplete — NO inventory published.");
    }
    process.exit(2);
  }

  // Complete + committed: also drop the authenticated inventory next to the
  // sealed DB artifacts (the copy in the backup store is the commit marker).
  const invPath = await writeInventoryFile(out, res.inventory);
  console.log(`  encrypted bytes:    ${res.inventory.total_bytes}`);
  console.log(`  inventory:          ${invPath}`);
  console.log("MEDIA BACKUP COMMITTED");
}

main().catch((err) => {
  console.error(`media:backup-s3 failed: ${(err as Error).message}`);
  process.exit(1);
});
