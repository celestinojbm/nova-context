import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConsolidation } from "../../src/memory/consolidate.js";
import { factHash } from "../../src/memory/fact-extractor.js";

/**
 * Review of #28: migration 0015 is reversible. On a scratch database:
 * 0000–0014 → snapshot → 0015 → applied consolidation runs → rollback script
 * → schema identical to the snapshot, every fact active again with its own
 * sources only, 0015 re-applies cleanly.
 */
const databaseUrl = process.env.DATABASE_URL;
const MIGRATIONS = new URL("../../../api/migrations/", import.meta.url);
const M15 = "0015_m20c_memory_consolidation.sql";
const DOWN = new URL("rollback/0015_m20c_memory_consolidation.down.sql", MIGRATIONS);
const scratch = `nova_m20c_down_${process.pid}_${Date.now()}`;

describe.skipIf(!databaseUrl)("M20c migration 0015 rollback (scratch database)", () => {
  let admin: pg.Pool;
  let db: pg.Pool;
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const apply = async (f: string) => {
    await db.query("BEGIN");
    await db.query(readFileSync(new URL(f, MIGRATIONS), "utf8"));
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    await db.query("COMMIT");
  };
  const schema = async () => (await db.query(
    `SELECT 'col' AS k, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS v
       FROM information_schema.columns WHERE table_schema = 'public'
     UNION ALL SELECT 'idx', indexdef FROM pg_indexes WHERE schemaname = 'public'
     UNION ALL SELECT 'con', conrelid::regclass || ':' || pg_get_constraintdef(oid) FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
     ORDER BY 1, 2`,
  )).rows.map((r) => `${r.k} ${r.v}`);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratch}`);
    const u = new URL(databaseUrl!);
    u.pathname = `/${scratch}`;
    db = new pg.Pool({ connectionString: u.toString(), max: 1 });
    db.on("error", () => undefined); // idle-client socket errors must not crash the run; queries still reject
    await db.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  });
  afterAll(async () => {
    // No pg_terminate_backend: killing a socket that pool.end() is still
    // closing surfaces as an unhandled 'error' and fails the run (seen in CI).
    await db?.end();
    for (let i = 0; ; i++) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
        break;
      } catch (err) {
        // 55006 = object_in_use: the closed pool's backends are still exiting.
        if ((err as { code?: string }).code !== "55006" || i >= 50) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await admin.end();
  });

  it("down script restores the pre-0015 schema and undoes applied runs; 0015 re-applies", async () => {
    expect(files).toContain(M15);
    for (const f of files.filter((f) => f < M15)) await apply(f);
    const before = await schema();
    await apply(M15);
    for (const f of files.filter((f) => f > M15)) await apply(f);

    const userId = (await db.query(`INSERT INTO users (email) VALUES ('down@nova.local') RETURNING id`)).rows[0].id;
    const ns = (await db.query(`INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, 'd', 'custom') RETURNING id`, [userId])).rows[0].id;
    const moment = async () => (await db.query(
      `INSERT INTO context_moments (user_id, source_mode) VALUES ($1, 'instant_capture') RETURNING id`, [userId])).rows[0].id;
    const fact = async (content: string, at: string, author = "model") => {
      const m = await moment();
      const id = (await db.query(
        `INSERT INTO memory_items (user_id, layer, content, status, valid_from, author, content_hash, namespace_id, moment_id)
         VALUES ($1, 'semantic', $2, 'active', $3, $4, $5, $6, $7) RETURNING id`,
        [userId, content, at, author, factHash(content), ns, m])).rows[0].id;
      await db.query(`INSERT INTO memory_item_sources (memory_item_id, moment_id) VALUES ($1, $2)`, [id, m]);
      return id;
    };
    await fact("Fluvia cobra 30 euros al mes.", "2026-01-01");
    await fact("Fluvia cobra 30 euros al mes", "2026-01-02");
    await fact("Dona usa Postgres como base de datos.", "2026-01-01");
    await fact("Dona usa MySQL como base de datos.", "2026-02-01");
    await fact("Nova vive en Madrid.", "2026-01-01", "user");
    await fact("Nova vive en Lisboa.", "2026-02-01");
    const r1 = await runConsolidation(db, userId, "apply");
    expect(r1.report).toMatchObject({ merges: 1, conflicts_newer_wins: 1, conflicts_contested: 1 });
    await fact("Dona usa SQLite como base de datos.", "2026-03-01");
    expect((await runConsolidation(db, userId, "apply")).report.conflicts_newer_wins).toBe(1);
    await runConsolidation(db, userId); // dry-run row too
    await db.query(`INSERT INTO ops_maintenance_runs (mode, report) VALUES ('apply', '{}')`); // a retention run

    await db.query("BEGIN");
    await db.query(readFileSync(DOWN, "utf8"));
    await db.query("COMMIT");

    expect(await schema()).toEqual(before);
    const st = (await db.query(`SELECT status, count(*)::int n FROM memory_items GROUP BY 1`)).rows;
    expect(st).toEqual([{ status: "active", n: 7 }]);
    const extra = (await db.query(
      `SELECT count(*)::int n FROM memory_item_sources s JOIN memory_items mi ON mi.id = s.memory_item_id
       WHERE s.moment_id IS DISTINCT FROM mi.moment_id`)).rows[0].n;
    expect(extra).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM ops_maintenance_runs`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [M15])).rowCount).toBe(0);

    await apply(M15); // forward again on the rolled-back database
    expect((await db.query(`SELECT count(*)::int n FROM ops_maintenance_runs WHERE job = 'retention'`)).rows[0].n).toBe(1);
  });
});
