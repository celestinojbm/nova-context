import { loadEnv } from "../env.js";
import { parseBackupKey } from "./crypto.js";
import { backupTarget, primaryTarget } from "./media-s3-env.js";
import {
  readInventoryFile,
  readInventoryFromStore,
  restoreMediaFromBackup,
  verifyMediaBackup,
} from "./media-s3.js";

/**
 * M18A operator command: restore backed-up encrypted media blobs into the
 * CONFIGURED media store (which, for a recovery drill, must be the ISOLATED
 * scratch store — run this with the scratch stack's NOVA_MEDIA_* env). The
 * inventory MAC is verified FIRST (wrong key/tamper fails closed); the
 * destination is refused when it aliases the backup store or fingerprints as
 * the ORIGINAL primary (override only via NOVA_MEDIA_RESTORE_ALLOW_PRIMARY=yes
 * for true disaster recovery). Dry-run by default; `--apply` copies and
 * re-verifies every written object. Never decrypts; counts only.
 *
 *   media:restore-s3 -- --stamp=<stamp> [--dir=<inventory-dir>] [--apply]
 *
 * After restoring, prove the pipeline whole with `media:verify` (DB refs
 * present AND decryptable with NOVA_ENCRYPTION_KEY).
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const stamp = arg("stamp");
  if (!stamp) throw new Error("usage: media:restore-s3 -- --stamp=<stamp> [--dir=<dir>] [--apply]");
  const apply = has("apply");
  const env = loadEnv();
  const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  const backup = backupTarget(env, process.env);
  const destination = await primaryTarget(env); // the SCRATCH stack's media env

  const dir = arg("dir");
  const inv = dir ? await readInventoryFile(dir, stamp) : await readInventoryFromStore(backup, stamp);
  if (!inv) throw new Error("no inventory found for that stamp");

  const verify = await verifyMediaBackup(inv, backup, key);
  if (!verify.ok) {
    console.error(
      `refusing to restore: backup verification failed (mac=${verify.manifest.mac}, ` +
        `missing=${verify.missing}, altered=${verify.altered})`,
    );
    process.exit(2);
  }

  const res = await restoreMediaFromBackup({
    inv,
    backup,
    destination,
    apply,
    allowPrimaryDestination: process.env.NOVA_MEDIA_RESTORE_ALLOW_PRIMARY === "yes",
  });
  console.log(`media restore (${apply ? "APPLIED" : "DRY RUN — pass --apply to copy"}):`);
  console.log(`  objects in backup:  ${inv.object_count}`);
  console.log(`  restored:           ${res.restored}`);
  console.log(`  already identical:  ${res.skippedIdentical}`);
  console.log(`  failed verify:      ${res.failedVerify}`);
  if (res.failedVerify > 0) process.exitCode = 2;
  else if (apply) console.log("next: run media:verify against the restored stack");
}

main().catch((err) => {
  console.error(`media:restore-s3 failed: ${(err as Error).message}`);
  process.exit(1);
});
