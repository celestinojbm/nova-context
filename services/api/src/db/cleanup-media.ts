import pg from "pg";
import { loadEnv } from "../env.js";
import { runMediaCleanup } from "../media/cleanup.js";
import { storeFromEnv } from "../media/object-store.js";

/**
 * M9 media cleanup (manual operator command):
 *
 *   pnpm --filter @nova/api media:cleanup                # dry run (default)
 *   pnpm --filter @nova/api media:cleanup -- --delete    # actually delete
 *   pnpm --filter @nova/api media:cleanup -- --delete --min-age-minutes=120
 *
 * Two jobs, both safe by construction:
 *   1. retries tombstoned blob deletions (media_delete_queue) so a failed
 *      delete never silently leaks an object;
 *   2. removes ORPHAN blobs — objects no moment_media row references
 *      (crash between blob write and DB insert). Valid media can never be
 *      deleted: the reference set spans ALL users. Blobs younger than
 *      --min-age-minutes (default 60) are skipped because a capture in
 *      flight writes its blob before its DB row.
 *
 * Works on ciphertext keys only — needs no encryption key, sees no pixels.
 */
const args = process.argv.slice(2);
const deleteMode = args.includes("--delete");
const minAgeArg = args.find((a) => a.startsWith("--min-age-minutes="));
const minAgeMinutes = minAgeArg ? Number(minAgeArg.split("=")[1]) : 60;
if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0) {
  console.error("--min-age-minutes must be a non-negative number");
  process.exit(1);
}

const env = loadEnv();
const store = storeFromEnv(env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

console.log(
  `Media cleanup (${deleteMode ? "DELETE" : "dry run"}) — store=${store.name}, min age ${minAgeMinutes}m`,
);
const report = await runMediaCleanup(pool, store, {
  deleteOrphans: deleteMode,
  minAgeMinutes,
});
console.log(`  objects in storage:        ${report.storedObjects}`);
console.log(`  referenced by moment_media: ${report.validObjects}`);
console.log(`  tombstoned deletes retried: ${report.queueDeleted} (still queued: ${report.queueRemaining})`);
console.log(`  orphans found:             ${report.orphans}`);
console.log(`  orphans skipped (too new): ${report.orphansSkippedRecent}`);
console.log(
  deleteMode
    ? `  orphans deleted:           ${report.orphansDeleted}`
    : `  (dry run — pass --delete to remove the ${report.orphans} orphan(s))`,
);
await pool.end();
