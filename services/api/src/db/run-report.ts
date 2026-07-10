import pg from "pg";
import { loadEnv } from "../env.js";
import { runAlphaReport } from "../ops/report.js";

/**
 * M13 operator command: aggregated alpha usage/friction report.
 *
 *   pnpm --filter @nova/api ops:report            # last 14 days
 *   pnpm --filter @nova/api ops:report -- --days=30
 */
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? Number.parseInt(daysArg.split("=")[1]!, 10) : 14;

const env = loadEnv();
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });

runAlphaReport(db, { days, mediaWarnMb: env.NOVA_MEDIA_WARN_MB })
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    return db.end();
  })
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("ops:report failed:", (err as Error).message);
    await db.end().catch(() => undefined);
    process.exit(1);
  });
