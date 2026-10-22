import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revertConsolidationRun, runConsolidation } from "../../src/memory/consolidate.js";
import { factHash } from "../../src/memory/fact-extractor.js";
import { trigramSimilarity } from "../../src/memory/consolidation-rules.js";

/** M20c consolidation against real Postgres + pg_trgm, on the 50 synthetic cases. */
const databaseUrl = process.env.DATABASE_URL;
interface Case { id: string; expected_relation: string; moments: { captured_at: string; expected_facts: string[] }[] }
const cases: Case[] = JSON.parse(
  readFileSync(new URL("../../eval/m20-synthetic-cases.json", import.meta.url), "utf8"),
).cases;

describe.skipIf(!databaseUrl)("M20c memory consolidation (integration)", () => {
  let db: pg.Pool;
  let userId: string;
  const byCase = new Map<string, { older: string; newer: string }>();

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: databaseUrl });
    userId = (await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`m20c-${Date.now()}@nova.local`])).rows[0].id;
    for (const c of cases) {
      const facts = c.moments.flatMap((m) => m.expected_facts.map((f) => ({ f, at: m.captured_at })));
      if (facts.length !== 2) continue;
      const ns = (await db.query(
        `INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, $2, 'custom') RETURNING id`,
        [userId, `eval/${c.id}`],
      )).rows[0].id;
      const ids: string[] = [];
      for (const x of facts) {
        ids.push((await db.query(
          `INSERT INTO memory_items (user_id, layer, content, status, valid_from, author, content_hash, namespace_id)
           VALUES ($1, 'semantic', $2, 'active', $3, 'model', $4, $5) RETURNING id`,
          [userId, x.f, x.at, factHash(x.f), ns],
        )).rows[0].id);
      }
      byCase.set(c.id, { older: ids[0]!, newer: ids[1]! });
    }
  });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await db.end();
  });

  it("pg_trgm similarity matches the JS mirror used for calibration", async () => {
    for (const c of cases.slice(10, 40)) {
      const [a, b] = c.moments.flatMap((m) => m.expected_facts);
      const { rows } = await db.query(`SELECT similarity($1, $2) AS s`, [a, b]);
      expect(Math.abs(Number(rows[0].s) - trigramSimilarity(a!, b!))).toBeLessThan(0.02);
    }
  });

  it("dry-run (default) reports counts and changes nothing", async () => {
    const { runId, report } = await runConsolidation(db, userId);
    expect(report).toMatchObject({ merges: 20, conflicts_newer_wins: 10, conflicts_contested: 0 });
    const run = (await db.query(`SELECT mode, job FROM ops_maintenance_runs WHERE id = $1`, [runId])).rows[0];
    expect(run).toEqual({ mode: "dry-run", job: "memory-consolidation" });
    const n = (await db.query(`SELECT count(*)::int n FROM memory_items WHERE user_id = $1 AND status <> 'active'`, [userId])).rows[0].n;
    expect(n).toBe(0);
  });

  it("apply merges, supersedes (newest wins), contests user facts, and reverts by run_id", async () => {
    // A user-authored fact in a conflict is never resolved automatically.
    await db.query(`UPDATE memory_items SET author = 'user' WHERE id = $1`, [byCase.get("m20-023")!.older]);
    const { runId, report } = await runConsolidation(db, userId, "apply");
    expect(report).toMatchObject({ merges: 20, conflicts_newer_wins: 9, conflicts_contested: 1 });
    const st = async (id: string) =>
      (await db.query(`SELECT status, canonical_id, supersedes_id FROM memory_items WHERE id = $1`, [id])).rows[0];
    const dup = byCase.get("m20-011")!;
    expect(await st(dup.newer)).toMatchObject({ status: "merged", canonical_id: dup.older });
    const cf = byCase.get("m20-021")!;
    expect(await st(cf.older)).toMatchObject({ status: "superseded" });
    expect(await st(cf.newer)).toMatchObject({ status: "active", supersedes_id: cf.older });
    const us = byCase.get("m20-023")!;
    expect((await st(us.older)).status).toBe("active");
    expect((await st(us.newer)).status).toBe("contested");
    expect((await st(byCase.get("m20-031")!.older)).status).toBe("active");
    const conflicts = (await db.query(
      `SELECT resolution, count(*)::int n FROM memory_conflicts WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [runId],
    )).rows;
    expect(conflicts).toEqual([{ resolution: "newer_wins", n: 9 }, { resolution: "open", n: 1 }]);

    expect((await runConsolidation(db, userId, "dry-run")).report.merges).toBe(0); // idempotent

    const { restored } = await revertConsolidationRun(db, runId);
    expect(restored).toBeGreaterThanOrEqual(30);
    expect(await st(dup.newer)).toMatchObject({ status: "active", canonical_id: null });
    expect(await st(cf.newer)).toMatchObject({ status: "active", supersedes_id: null });
    const open = (await db.query(
      `SELECT count(*)::int n FROM memory_conflicts WHERE run_id = $1 AND resolution <> 'user_resolved'`, [runId],
    )).rows[0].n;
    expect(open).toBe(0);
    expect((await revertConsolidationRun(db, runId)).restored).toBe(0);
  });
});
