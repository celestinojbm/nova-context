import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv } from "../env.js";

/**
 * Minimal forward-only migration runner: applies migrations/*.sql in
 * lexicographic order, tracking applied files in schema_migrations.
 * Deliberately not drizzle-kit/prisma — M0 needs exactly this and nothing
 * more (BUILD_PLAN: prototype over platform).
 */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../migrations",
    );
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (rowCount) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** M11: migrations on disk that have not been applied (readiness check). */
export async function pendingMigrations(db: {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<string[]> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await db.query("SELECT name FROM schema_migrations");
  const appliedSet = new Set(rows.map((r) => r.name as string));
  return files.filter((f) => !appliedSet.has(f));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const env = loadEnv();
  migrate(env.DATABASE_URL)
    .then((applied) => {
      console.log(
        applied.length
          ? `Applied migrations: ${applied.join(", ")}`
          : "No pending migrations.",
      );
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
