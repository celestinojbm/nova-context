import pg from "pg";
import { loadEnv } from "../env.js";
import { pendingMigrations } from "./migrate.js";

/**
 * M18A.1 operator command: confirm zero pending migrations.
 *
 *   pnpm --filter @nova/api db:migrate:status
 *
 * Connects to DATABASE_URL, compares migrations/*.sql on disk against the
 * applied set, and prints ONLY the pending COUNT (never SQL, never DSN).
 * Exit 0 when the database is current; exit 2 when any migration is pending.
 * Used by `validate:deploy` as the explicit "no pending migrations" gate
 * AFTER db:migrate has run — reusing the existing pendingMigrations() rather
 * than duplicating migration logic.
 */
const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
try {
  const names = await pendingMigrations({ query: (sql: string) => pool.query(sql) });
  if (names.length === 0) {
    console.log("migrations current: 0 pending");
    process.exitCode = 0;
  } else {
    console.error(`migrations NOT current: ${names.length} pending`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`db:migrate:status failed: ${(err as Error).message.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
