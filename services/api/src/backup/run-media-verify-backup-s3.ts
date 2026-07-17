import { loadEnv } from "../env.js";
import { parseBackupKey } from "./crypto.js";
import { backupTarget } from "./media-s3-env.js";
import { readInventoryFile, readInventoryFromStore, verifyMediaBackup } from "./media-s3.js";

/**
 * M18A operator command: verify a media backup — inventory MAC (fails closed
 * on a wrong NOVA_BACKUP_KEY or ANY tampering) plus every object's size and
 * sha256 in the backup store. Read-only; never decrypts; counts only.
 *
 *   media:verify-backup-s3 -- --stamp=<stamp> [--dir=<inventory-dir>]
 *
 * With --dir the local inventory file is authoritative; otherwise the copy
 * stored inside the backup store (media/<stamp>/inventory.json) is used.
 * Exit codes: 0 = verified; 2 = MAC/shape failure or missing/altered objects.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const stamp = arg("stamp");
  if (!stamp) throw new Error("usage: media:verify-backup-s3 -- --stamp=<stamp> [--dir=<dir>]");
  const env = loadEnv();
  const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  const backup = backupTarget(env, process.env);

  const dir = arg("dir");
  const inv = dir ? await readInventoryFile(dir, stamp) : await readInventoryFromStore(backup, stamp);
  if (!inv) throw new Error("no inventory found for that stamp");

  const res = await verifyMediaBackup(inv, backup, key);
  console.log(`media backup verification (stamp ${stamp}):`);
  console.log(`  inventory shape: ${res.manifest.shape}${res.manifest.detail ? ` (${res.manifest.detail})` : ""}`);
  console.log(`  inventory mac:   ${res.manifest.mac}`);
  console.log(`  objects:         ${res.objectCount}`);
  console.log(`  verified:        ${res.verified}`);
  console.log(`  missing:         ${res.missing}`);
  console.log(`  altered:         ${res.altered}`);
  console.log(res.ok ? "MEDIA BACKUP VERIFIED" : "MEDIA BACKUP VERIFICATION FAILED");
  if (!res.ok) process.exitCode = 2;
}

main().catch((err) => {
  console.error(`media:verify-backup-s3 failed: ${(err as Error).message}`);
  process.exit(1);
});
