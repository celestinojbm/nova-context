import {
  decryptBytes,
  decryptSecret,
  encryptBytes,
  encryptSecret,
  parseEncryptionKey,
} from "@nova/context-engine/secret-box";
import pg from "pg";
import { loadEnv } from "../env.js";
import { storeFromEnv } from "../media/object-store.js";

/**
 * M9 key rotation v0 (manual operator command):
 *
 *   NOVA_ENCRYPTION_KEY=<new> NOVA_ENCRYPTION_KEY_OLD=<current> \
 *     pnpm --filter @nova/api media:rotate-key            # dry run
 *   ... media:rotate-key -- --apply                        # re-encrypt
 *
 * Re-encrypts every media blob (full + thumbnail) and every active
 * integration token from the OLD key to the NEW key. Plaintext exists only
 * in this process's memory for the microseconds between decrypt and
 * re-encrypt; nothing is ever logged or written unencrypted.
 *
 * Safe to rerun / resumable by construction: each blob is first tried with
 * the NEW key — if that succeeds it was already rotated and is skipped, so
 * an interrupted run just continues where it stopped. Blobs neither key
 * can open are counted, named by media id (never content), and left
 * untouched.
 *
 * Operational order: run with --apply, verify `undecryptable: 0`, then
 * deploy the API/worker with NOVA_ENCRYPTION_KEY=<new> and drop the old
 * key. Until the deploy flips, the running API still serves with the old
 * key — rotate during a maintenance window or accept a brief read-error
 * window for already-rotated blobs.
 */
const apply = process.argv.slice(2).includes("--apply");
const env = loadEnv();
if (!env.NOVA_ENCRYPTION_KEY || !env.NOVA_ENCRYPTION_KEY_OLD) {
  console.error(
    "Set NOVA_ENCRYPTION_KEY (new) and NOVA_ENCRYPTION_KEY_OLD (current) to rotate.",
  );
  process.exit(1);
}
const newKey = parseEncryptionKey(env.NOVA_ENCRYPTION_KEY);
const oldKey = parseEncryptionKey(env.NOVA_ENCRYPTION_KEY_OLD);
if (newKey.equals(oldKey)) {
  console.error("NOVA_ENCRYPTION_KEY and NOVA_ENCRYPTION_KEY_OLD are the same key.");
  process.exit(1);
}

const store = storeFromEnv(env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

console.log(`Key rotation (${apply ? "APPLY" : "dry run"}) — store=${store.name}`);

// --- media blobs -------------------------------------------------------------
const { rows: media } = await pool.query<{
  id: string;
  storage_key: string;
  thumb_key: string | null;
}>(`SELECT id, storage_key, thumb_key FROM moment_media ORDER BY created_at ASC`);

let rotated = 0;
let alreadyRotated = 0;
let missing = 0;
let undecryptable = 0;

for (const row of media) {
  const keys = [row.storage_key, ...(row.thumb_key ? [row.thumb_key] : [])];
  for (const key of keys) {
    const blob = await store.get(key);
    if (!blob) {
      missing += 1;
      continue;
    }
    try {
      decryptBytes(newKey, blob);
      alreadyRotated += 1;
      continue; // resumability: already on the new key
    } catch {
      /* not the new key — try the old one */
    }
    let plain: Buffer;
    try {
      plain = decryptBytes(oldKey, blob);
    } catch {
      undecryptable += 1;
      console.warn(`  cannot decrypt media ${row.id} (${key === row.thumb_key ? "thumb" : "full"}) with either key — left untouched`);
      continue;
    }
    if (apply) await store.put(key, encryptBytes(newKey, plain));
    rotated += 1;
  }
}

// --- integration tokens (same key, same rotation) ----------------------------
const { rows: connections } = await pool.query<{ id: string; token_ciphertext: Buffer }>(
  `SELECT id, token_ciphertext FROM integration_connections
   WHERE status = 'active' AND length(token_ciphertext) > 0`,
);
let tokensRotated = 0;
let tokensAlready = 0;
let tokensFailed = 0;
for (const conn of connections) {
  try {
    decryptSecret(newKey, conn.token_ciphertext);
    tokensAlready += 1;
    continue;
  } catch {
    /* try old key */
  }
  let token: string;
  try {
    token = decryptSecret(oldKey, conn.token_ciphertext);
  } catch {
    tokensFailed += 1;
    console.warn(`  cannot decrypt integration token ${conn.id} with either key — left untouched`);
    continue;
  }
  if (apply) {
    await pool.query(
      `UPDATE integration_connections SET token_ciphertext = $1, updated_at = now() WHERE id = $2`,
      [encryptSecret(newKey, token), conn.id],
    );
  }
  tokensRotated += 1;
}

console.log(`  media blobs ${apply ? "rotated" : "to rotate"}:   ${rotated}`);
console.log(`  media already on new key:  ${alreadyRotated}`);
console.log(`  media blobs missing:       ${missing}`);
console.log(`  media undecryptable:       ${undecryptable}`);
console.log(`  tokens ${apply ? "rotated" : "to rotate"}:        ${tokensRotated}`);
console.log(`  tokens already on new key: ${tokensAlready}`);
console.log(`  tokens undecryptable:      ${tokensFailed}`);
if (!apply) console.log("  (dry run — pass --apply to re-encrypt)");
if (undecryptable || tokensFailed) process.exitCode = 2;
await pool.end();
