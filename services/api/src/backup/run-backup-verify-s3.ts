import { loadEnv } from "../env.js";
import { parseBackupKey } from "./crypto.js";
import { backupTarget } from "./media-s3-env.js";
import { sanitizeBackupError } from "./sanitize.js";
import { verifySealedBackupRemote } from "./sealed-backup-s3.js";

/**
 * M18A.2 §3 operator command: verify a COMMITTED remote sealed backup set —
 * authenticate the remote marker (HMAC with NOVA_BACKUP_KEY; fails closed on a
 * wrong/absent key or any tampering) and re-hash every artifact object in the
 * remote store. Read-only; never decrypts; counts only.
 *
 *   backup:verify-s3 -- --stamp=<stamp>
 *
 * Exit 0 = verified; 2 = missing marker / MAC or shape failure / missing or
 * altered object.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const stamp = arg("stamp");
  if (!stamp) throw new Error("usage: backup:verify-s3 -- --stamp=<stamp>");
  const env = loadEnv();
  const key = process.env.NOVA_BACKUP_KEY ? parseBackupKey(process.env.NOVA_BACKUP_KEY) : null;
  const backup = backupTarget(env, process.env);

  const res = await verifySealedBackupRemote({ store: backup.store, stamp, backupKey: key });
  console.log(`remote sealed backup verification (stamp ${stamp}):`);
  console.log(`  marker shape: ${res.marker.shape}${res.marker.detail ? ` (${res.marker.detail})` : ""}`);
  console.log(`  marker mac:   ${res.marker.mac}`);
  console.log(`  expected:     ${res.expected}`);
  console.log(`  verified:     ${res.verified}`);
  console.log(`  missing:      ${res.missing.length}`);
  console.log(`  altered:      ${res.altered.length}`);
  console.log(res.ok ? "REMOTE SEALED BACKUP VERIFIED" : "REMOTE SEALED BACKUP VERIFICATION FAILED");
  if (!res.ok) process.exit(2);
}

main().catch((err) => {
  console.error(`backup:verify-s3 failed: ${sanitizeBackupError((err as Error).message)}`);
  process.exit(1);
});
