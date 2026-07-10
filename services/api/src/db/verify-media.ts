import { decryptBytesWithAny, parseEncryptionKey, parseKeyList } from "@nova/context-engine/secret-box";
import pg from "pg";
import { loadEnv } from "../env.js";
import { storeFromEnv } from "../media/object-store.js";

/**
 * M11 restore/backup verification (operator command):
 *
 *   pnpm --filter @nova/api media:verify
 *
 * Walks every moment_media row and proves the pipeline is whole: the blob
 * exists in object storage AND decrypts with a configured key
 * (NOVA_ENCRYPTION_KEY + NOVA_ENCRYPTION_KEYS_PREVIOUS). Run it after a
 * restore, after a key rotation, or before declaring a backup good.
 * Nothing is modified; nothing decrypted is printed or written.
 *
 * Exit codes: 0 = everything verifies; 2 = missing/undecryptable found.
 */
const env = loadEnv();
if (!env.NOVA_ENCRYPTION_KEY) {
  console.error("NOVA_ENCRYPTION_KEY is required to verify decryptability.");
  process.exit(1);
}
const keys = [
  parseEncryptionKey(env.NOVA_ENCRYPTION_KEY),
  ...(env.NOVA_ENCRYPTION_KEYS_PREVIOUS ? parseKeyList(env.NOVA_ENCRYPTION_KEYS_PREVIOUS) : []),
];
const store = storeFromEnv(env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

const { rows } = await pool.query<{ id: string; storage_key: string; thumb_key: string | null }>(
  `SELECT id, storage_key, thumb_key FROM moment_media ORDER BY created_at ASC`,
);
let okCount = 0;
let missing = 0;
let undecryptable = 0;
for (const row of rows) {
  for (const key of [row.storage_key, ...(row.thumb_key ? [row.thumb_key] : [])]) {
    const blob = await store.get(key);
    if (!blob) {
      missing += 1;
      console.warn(`  MISSING media ${row.id} (${key === row.thumb_key ? "thumb" : "full"})`);
      continue;
    }
    try {
      decryptBytesWithAny(keys, blob);
      okCount += 1;
    } catch {
      undecryptable += 1;
      console.warn(`  UNDECRYPTABLE media ${row.id} (${key === row.thumb_key ? "thumb" : "full"})`);
    }
  }
}
console.log(`Media verification (${rows.length} rows, ${keys.length} key(s)):`);
console.log(`  blobs verified:  ${okCount}`);
console.log(`  blobs missing:   ${missing}`);
console.log(`  undecryptable:   ${undecryptable}`);
if (missing || undecryptable) process.exitCode = 2;
await pool.end();
