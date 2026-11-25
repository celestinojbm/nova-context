import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0019 on a scratch database: every migration except 0019 → schema snapshot →
 * 0019 + a vector with its hash → rollback script → schema identical to the
 * snapshot, the vector kept (only the hash is lost) → 0019 re-applies and the
 * old row reads as "no hash" (re-embedded once by the worker).
 */
const databaseUrl = process.env.DATABASE_URL;
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const M19 = "0019_m20i_embedding_content_hash.sql";
const DOWN = readFileSync(new URL("rollback/0019_m20i_embedding_content_hash.down.sql", MIGRATIONS), "utf8");
const scratch = `nova_m20i_down_${process.pid}_${Date.now()}`;

describe.skipIf(!databaseUrl)("M20i migration 0019 (scratch database)", () => {
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
  const apply = (f: string) =>
    run(`${readFileSync(new URL(f, MIGRATIONS), "utf8")};\nINSERT INTO schema_migrations (name) VALUES ('${f}')`);
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
    expect(files).toContain(M19);
    for (const f of files.filter((f) => f !== M19)) await apply(f);
    before = await schema();
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin?.end();
  });

  it("adds a nullable content_sha256; down restores the pre-0019 schema and keeps vectors; 0019 re-applies", async () => {
    await apply(M19);
    const col = (await db.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'memory_item_embeddings' AND column_name = 'content_sha256'`,
    )).rows;
    expect(col).toEqual([{ is_nullable: "YES" }]);

    const userId = (await db.query(`INSERT INTO users (email) VALUES ('emb-hash-down@nova.local') RETURNING id`)).rows[0].id;
    const item = (await db.query(
      `INSERT INTO memory_items (user_id, layer, content, author) VALUES ($1, 'semantic', 'Drives a Mazda', 'model') RETURNING id`,
      [userId],
    )).rows[0].id;
    await db.query(
      `INSERT INTO memory_item_embeddings (memory_item_id, model, embedding, content_sha256) VALUES ($1, 'test/fake-384', $2::vector, 'abc')`,
      [item, `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`],
    );

    await run(DOWN);
    expect(await schema()).toEqual(before);
    expect((await db.query(`SELECT count(*)::int n FROM memory_item_embeddings`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [M19])).rowCount).toBe(0);

    await apply(M19);
    expect((await db.query(`SELECT content_sha256 FROM memory_item_embeddings`)).rows).toEqual([{ content_sha256: null }]);
  });
});
