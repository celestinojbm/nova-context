import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0017 on a scratch database:
 * - its pgvector guard fails with an explicit message and applies nothing when
 *   the extension is missing, cannot be created by the migration role, or is
 *   too old for HNSW (simulated by renaming the extension / switching to a role
 *   without superuser / raising the minimum version: CI always has pgvector);
 * - it is reversible: every migration except 0017 → schema snapshot → 0017 +
 *   a stored vector → rollback script → schema identical to the snapshot,
 *   facts intact, pgvector still installed → 0017 re-applies.
 */
const databaseUrl = process.env.DATABASE_URL;
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const M17 = "0017_m20e_memory_embeddings.sql";
const UP = readFileSync(new URL(M17, MIGRATIONS), "utf8");
const DOWN = readFileSync(new URL("rollback/0017_m20e_memory_embeddings.down.sql", MIGRATIONS), "utf8");
const scratch = `nova_m20e_down_${process.pid}_${Date.now()}`;
const noSuper = `${scratch}_nosuper`;

describe.skipIf(!databaseUrl)("M20e migration 0017 (scratch database)", () => {
  let admin: pg.Client;
  let db: pg.Client;
  let before: string[];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const run = async (sql: string) => {
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  };
  const apply = (f: string, sql = readFileSync(new URL(f, MIGRATIONS), "utf8")) =>
    run(`${sql};\nINSERT INTO schema_migrations (name) VALUES ('${f}')`);
  const schema = async () => (await db.query(
    `SELECT 'col' AS k, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS v
       FROM information_schema.columns WHERE table_schema = 'public'
     UNION ALL SELECT 'idx', indexdef FROM pg_indexes WHERE schemaname = 'public'
     UNION ALL SELECT 'con', conrelid::regclass || ':' || pg_get_constraintdef(oid) FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
     ORDER BY 1, 2`,
  )).rows.map((r) => `${r.k} ${r.v}`);
  const tableExists = async () =>
    (await db.query(`SELECT to_regclass('public.memory_item_embeddings') AS t`)).rows[0].t !== null;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratch}`);
    const u = new URL(databaseUrl!);
    u.pathname = `/${scratch}`;
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    expect(files).toContain(M17);
    for (const f of files.filter((f) => f !== M17)) await apply(f);
    before = await schema();
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin?.query(`DROP ROLE IF EXISTS ${noSuper}`);
    await admin?.end();
  });

  it("fails with an explicit message and applies nothing when pgvector is missing", async () => {
    const missing = UP.replace("ext CONSTANT text := 'vector'", "ext CONSTANT text := 'vector_absent_test'");
    expect(missing).not.toBe(UP);
    await expect(apply(M17, missing)).rejects.toThrow(
      /M20e needs the pgvector extension \("vector_absent_test"\).*Nothing was applied/,
    );
    expect(await tableExists()).toBe(false);
    expect((await db.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [M17])).rowCount).toBe(0);
  });

  it("fails with an explicit message when the migration role may not create the extension", async () => {
    // file_fdw is an untrusted contrib extension: available, but only a
    // superuser may create it — the same situation as pgvector on a managed
    // Postgres whose migration role is not an admin.
    await admin.query(`CREATE ROLE ${noSuper} NOLOGIN NOSUPERUSER`);
    const noPriv = UP.replace("ext CONSTANT text := 'vector'", "ext CONSTANT text := 'file_fdw'");
    expect(noPriv).not.toBe(UP);
    await expect(apply(M17, `SET LOCAL ROLE ${noSuper};\n${noPriv}`)).rejects.toThrow(
      /the migration role may not create it\. Run CREATE EXTENSION file_fdw; as a superuser.*Nothing was applied/,
    );
    expect(await tableExists()).toBe(false);
    expect((await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'file_fdw'`)).rowCount).toBe(0);
  });

  it("fails with an explicit message when pgvector is too old for HNSW", async () => {
    const tooOld = UP.replace("ARRAY[0,5,0]", "ARRAY[99,0,0]");
    expect(tooOld).not.toBe(UP);
    await expect(apply(M17, tooOld)).rejects.toThrow(/M20e needs pgvector >= 99\.0\.0 for HNSW.*ALTER EXTENSION vector UPDATE/);
    expect(await tableExists()).toBe(false);
  });

  it("down script restores the pre-0017 schema, keeps facts and pgvector; 0017 re-applies", async () => {
    await apply(M17);
    const userId = (await db.query(`INSERT INTO users (email) VALUES ('emb-down@nova.local') RETURNING id`)).rows[0].id;
    const item = (await db.query(
      `INSERT INTO memory_items (user_id, layer, content, author) VALUES ($1, 'semantic', 'Drives a Mazda', 'model') RETURNING id`,
      [userId],
    )).rows[0].id;
    await db.query(
      `INSERT INTO memory_item_embeddings (memory_item_id, model, embedding) VALUES ($1, 'test/fake-384', $2::vector)`,
      [item, `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`],
    );

    await run(DOWN);
    expect(await schema()).toEqual(before);
    expect((await db.query(`SELECT content FROM memory_items`)).rows).toEqual([{ content: "Drives a Mazda" }]);
    expect((await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).rowCount).toBe(1);
    expect((await db.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [M17])).rowCount).toBe(0);

    await apply(M17); // forward again on the rolled-back database
    expect(await tableExists()).toBe(true);
  });
});
