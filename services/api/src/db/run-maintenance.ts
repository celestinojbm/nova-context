import pg from "pg";
import { loadEnv } from "../env.js";
import { storeFromEnv } from "../media/object-store.js";
import { runMaintenance } from "../ops/maintenance.js";

/**
 * M11 maintenance (operator command; wire to cron if desired):
 *
 *   pnpm --filter @nova/api ops:maintenance                      # dry run
 *   pnpm --filter @nova/api ops:maintenance -- --apply
 *   pnpm --filter @nova/api ops:maintenance -- --apply --prune-events-days=90
 *
 * Dry-run by default; destructive sections only act with --apply. Failed
 * actions are only SURFACED (never deleted). Product events are pruned
 * only when --prune-events-days is explicitly given.
 */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const pruneArg = args.find((a) => a.startsWith("--prune-events-days="));
const minAgeArg = args.find((a) => a.startsWith("--min-age-minutes="));

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
const store = storeFromEnv(env);

const report = await runMaintenance(pool, store, {
  apply,
  pruneEventsDays: pruneArg ? Number(pruneArg.split("=")[1]) : null,
  minAgeMinutes: minAgeArg ? Number(minAgeArg.split("=")[1]) : undefined,
});
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log("\n(dry run — pass --apply to act)");
await pool.end();
