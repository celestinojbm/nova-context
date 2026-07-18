import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../env.js";
import { parseBackupKey } from "./crypto.js";
import { verifyBackup } from "./manifest.js";
import { backupTarget } from "./media-s3-env.js";
import { fetchSealedBackup } from "./sealed-backup-s3.js";

/**
 * M18A.2 §3 operator command: fetch a COMMITTED remote sealed backup set into a
 * local directory, verifying the remote marker + every object hash BEFORE (and
 * during) download, then running the existing `backup:verify` over the fetched
 * set. Fails before restore on any missing/altered artifact.
 *
 *   backup:fetch-s3 -- --stamp=<stamp> [--out=<dir>]
 *
 * With --out the set is fetched there and LEFT for the subsequent restore step
 * (the caller/job owns cleanup — a Render job's filesystem is ephemeral). With
 * no --out, a private 0700 temp dir is used and REMOVED at exit — an integrity
 * check that proves the committed set is fetchable + intact, leaving nothing on
 * disk. NO plaintext is ever written (only the sealed .enc artifacts + json).
 *
 * Exit 0 = fetched + verified; 2 = verification failure; 1 = other error.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const stamp = arg("stamp");
  if (!stamp) throw new Error("usage: backup:fetch-s3 -- --stamp=<stamp> [--out=<dir>]");
  const outArg = arg("out");
  const env = loadEnv();
  const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  const backup = backupTarget(env, process.env);

  const dest = outArg ?? (await mkdtemp(join(tmpdir(), "nova-fetch-")));
  if (!outArg) await chmod(dest, 0o700);
  let ok = false;
  try {
    const res = await fetchSealedBackup({ store: backup.store, stamp, backupKey: key, destDir: dest });
    // Run the existing sealed-backup verifier over the fetched set.
    const v = await verifyBackup(dest, stamp, key);
    ok = res.ok && v.ok;
    console.log(`sealed backup fetch (stamp ${stamp}):`);
    console.log(`  fetched:  ${res.files.length}/${res.expected}`);
    console.log(`  verified: ${res.verified}`);
    console.log(`  backup:verify — manifest mac:${v.manifest.mac} → ${v.ok ? "ok" : "FAILED"}`);
    console.log(ok ? "SEALED BACKUP FETCH OK (committed set, verified)" : "SEALED BACKUP FETCH VERIFICATION FAILED");
  } finally {
    if (!outArg) await rm(dest, { recursive: true, force: true });
  }
  if (!ok) process.exit(2);
}

main().catch((err) => {
  console.error(`backup:fetch-s3 failed: ${(err as Error).message}`);
  process.exit(1);
});
