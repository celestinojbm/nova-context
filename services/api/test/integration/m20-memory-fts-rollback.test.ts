import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0016 is reversible. On a scratch database: every migration except 0016 →
 * schema snapshot → 0016 + facts → rollback script → schema identical to the
 * snapshot, facts intact, 0016 re-applies and rebuilds tsv for existing rows.
 * 0016 goes last to mirror production, where later-numbered migrations from
 * main (0018) can already be applied: the migrator skips by name, not order.
 */
const databaseUrl = process.env.DATABASE_URL;
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const M16 = "0016_m20_memory_fts.sql";
const DOWN = new URL("rollback/0016_m20_memory_fts.down.sql", MIGRATIONS);
const scratch = `nova_m20_fts_down_${process.pid}_${Date.now()}`;

describe.skipIf(!databaseUrl)("M20 migration 0016 rollback (scratch database)", () => {
  let admin: pg.Client;
  let db: pg.Client;
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const run = async (sql: string) => {
    await db.query("BEGIN");
    await db.query(sql);
    await db.query("COMMIT");
  };
  const apply = (f: string) =>
    run(`${readFileSync(new URL(f, MIGRATIONS), "utf8")};
         INSERT INTO schema_migrations (name) VALUES ('${f}')`);
  const schema = async () => (await db.query(
    `SELECT 'col' AS k, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS v
       FROM information_schema.columns WHERE table_schema = 'public'
     UNION ALL SELECT 'idx', indexdef FROM pg_indexes WHERE schemaname = 'public'
     UNION ALL SELECT 'con', conrelid::regclass || ':' || pg_get_constraintdef(oid) FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
     ORDER BY 1, 2`,
  )).rows.map((r) => `${r.k} ${r.v}`);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    const u = new URL(databaseUrl!);
    u.pathname = `/${scratch}`;
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin?.end();
  });

  it("down script restores the pre-0016 schema, keeps facts; 0016 re-applies", async () => {
    expect(files).toContain(M16);
    for (const f of files.filter((f) => f !== M16)) await apply(f);
    const before = await schema();
    await apply(M16);

    const userId = (await db.query(`INSERT INTO users (email) VALUES ('fts-down@nova.local') RETURNING id`)).rows[0].id;
    await db.query(
      `INSERT INTO memory_items (user_id, layer, content, author) VALUES ($1, 'semantic', 'Su coche es un Mazda rojo', 'model')`,
      [userId],
    );

    await run(readFileSync(DOWN, "utf8"));
    expect(await schema()).toEqual(before);
    expect((await db.query(`SELECT content FROM memory_items`)).rows).toEqual([{ content: "Su coche es un Mazda rojo" }]);
    expect((await db.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [M16])).rowCount).toBe(0);

    await apply(M16); // forward again on the rolled-back database
    const hit = await db.query(`SELECT 1 FROM memory_items WHERE tsv @@ to_tsquery('simple', 'mazda')`);
    expect(hit.rowCount).toBe(1);
  });
});
