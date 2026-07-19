import { loadEnv } from "../env.js";
import { parseBackupKey } from "./crypto.js";
import { backupTarget } from "./media-s3-env.js";
import { sanitizeBackupError } from "./sanitize.js";
import { publishSealedBackup } from "./sealed-backup-s3.js";

/**
 * M18A.2 §3 operator command: publish a COMPLETE sealed backup set to the
 * remote backup store (NOVA_BACKUP_S3_*) so an ephemeral Render job's local
 * sealed artifacts survive teardown.
 *
 *   backup:publish-s3 -- --dir=<sealed-backup-dir> --stamp=<stamp> [--apply]
 *
 * Verifies the LOCAL backup first, uploads + re-verifies each artifact, then
 * publishes the authenticated commit marker LAST. Dry-run by default; NOTHING
 * is uploaded without --apply. Console output is counts-only — never keys,
 * credentials, endpoints, or content. Exit 0 = ok; 1 = failure.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const dir = arg("dir");
  const stamp = arg("stamp");
  if (!dir || !stamp) throw new Error("usage: backup:publish-s3 -- --dir=<dir> --stamp=<stamp> [--apply]");
  const apply = process.argv.includes("--apply");
  const env = loadEnv();
  const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  const backup = backupTarget(env, process.env);
  const createdAt = arg("created-at") ?? new Date().toISOString();

  const res = await publishSealedBackup({ dir, stamp, store: backup.store, backupKey: key, createdAt, apply });
  console.log(`sealed backup publish (stamp ${stamp}):`);
  console.log(`  artifacts:    ${res.expected}`);
  if (!res.applied) {
    console.log(`  would publish ${res.expected} artifact(s) to sealed-backups/${stamp}/ (+ commit marker)`);
    console.log("SEALED BACKUP PUBLISH DRY RUN OK (no data uploaded; pass --apply to commit)");
    return;
  }
  console.log(`  uploaded:     ${res.uploaded.length}`);
  console.log(`  verified@dst: ${res.verifiedAtDestination}`);
  console.log("SEALED BACKUP PUBLISHED (remote commit marker written LAST)");
}

main().catch((err) => {
  console.error(`backup:publish-s3 failed: ${sanitizeBackupError((err as Error).message)}`);
  process.exit(1);
});
