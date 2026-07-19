import { realpathSync } from "node:fs";
import { parseBackupKey, decryptFile } from "./crypto.js";
import { sanitizeBackupError } from "./sanitize.js";

/**
 * M18A.3 §6: decrypt ONE sealed backup artifact to a plaintext output path,
 * using NOVA_BACKUP_KEY. This is the single, robust unseal primitive
 * scripts/restore.sh calls — it replaces the earlier fragile inline `tsx -e`
 * eval (whose relative-import + top-level-await behavior differs across tsx
 * transpile modes). The auth tag is verified by decryptFile; a wrong key or a
 * tampered artifact throws before any plaintext is usable.
 *
 *   backup:unseal-file -- --in=<sealed.enc> --out=<plaintext>
 *
 * Prints NOTHING on success except a one-line confirmation (no key, no
 * content, no raw paths beyond the operator-supplied ones). Exit 0 = written;
 * 2 = decryption/auth failure; 1 = other (usage/IO) error.
 */
const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const inPath = arg("in");
  const outPath = arg("out");
  if (!inPath || !outPath) {
    throw new Error("usage: backup:unseal-file -- --in=<sealed.enc> --out=<plaintext>");
  }
  const key = parseBackupKey(process.env.NOVA_BACKUP_KEY);
  // Resolve the input to a real path so a symlinked sealed artifact can't
  // redirect the read; the output is created fresh by decryptFile (mode 0600).
  const realIn = realpathSync(inPath);
  try {
    await decryptFile(realIn, outPath, key);
  } catch (err) {
    console.error(`backup:unseal-file: decryption/auth FAILED: ${sanitizeBackupError((err as Error).message)}`);
    process.exit(2);
  }
  console.log("UNSEAL OK");
}

main().catch((err) => {
  console.error(`backup:unseal-file failed: ${sanitizeBackupError((err as Error).message)}`);
  process.exit(1);
});
