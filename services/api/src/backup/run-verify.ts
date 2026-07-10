import { parseBackupKey } from "./crypto.js";
import { verifyBackup } from "./manifest.js";

/**
 * M15 operator command: verify a backup's integrity.
 *
 *   backup:verify -- --dir=<backup-dir> --stamp=<stamp>
 *
 * Recomputes each sealed artifact's sha256 against the manifest (catches
 * tampering/corruption WITHOUT the key). If NOVA_BACKUP_KEY is set, also
 * confirms each artifact actually decrypts (GCM auth tag). Exit 0 = all
 * checks pass; exit 1 = any mismatch, missing file, or decrypt failure.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const dir = arg("dir");
  const stamp = arg("stamp");
  if (!dir || !stamp) throw new Error("usage: backup:verify -- --dir=<dir> --stamp=<stamp>");

  let key: Buffer | null = null;
  if (process.env.NOVA_BACKUP_KEY) {
    try {
      key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  const result = await verifyBackup(dir, stamp, key);
  console.log(`nova backup:verify — ${dir} @ ${stamp}${key ? "" : " (hash-only; no key)"}`);
  for (const c of result.checks) {
    const parts = [`hash:${c.hash}`, ...(c.decrypt ? [`decrypt:${c.decrypt}`] : [])];
    console.log(`  ${result.ok && c.hash === "ok" ? "✓" : "✗"} ${c.artifact} — ${parts.join(" ")}`);
  }
  console.log(result.ok ? "BACKUP OK" : "BACKUP VERIFY FAILED");
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("backup:verify failed:", (err as Error).message);
  process.exit(1);
});
