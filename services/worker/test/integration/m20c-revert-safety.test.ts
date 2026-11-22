import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revertConsolidationRun, runConsolidation } from "../../src/memory/consolidate.js";
import { factHash } from "../../src/memory/fact-extractor.js";

/**
 * Review of #28: a revert must never clobber state written by a LATER run,
 * and must undo every side effect of its own run (incl. sources copied to
 * the canonical fact).
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("M20c revert safety (integration)", () => {
  let db: pg.Pool;
  let userId: string;
  let ns: string;
  const fact = async (content: string, at: string, momentId: string | null = null) =>
    (await db.query(
      `INSERT INTO memory_items (user_id, layer, content, status, valid_from, author, content_hash, namespace_id, moment_id)
       VALUES ($1, 'semantic', $2, 'active', $3, 'model', $4, $5, $6) RETURNING id`,
      [userId, content, at, factHash(content), ns, momentId],
    )).rows[0].id as string;
  const st = async (id: string) =>
    (await db.query(`SELECT status, canonical_id, supersedes_id FROM memory_items WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: databaseUrl });
    userId = (await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`m20c-rv-${Date.now()}@nova.local`])).rows[0].id;
    ns = (await db.query(`INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, 'rv', 'custom') RETURNING id`, [userId])).rows[0].id;
  });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await db.end();
  });

  it("reverting an older run after a newer one does not resurrect or unlink facts the newer run changed", async () => {
    const x = await fact("Dona usa Postgres como base de datos.", "2026-01-01");
    const y = await fact("Dona usa MySQL como base de datos.", "2026-02-01");
    const run1 = await runConsolidation(db, userId, "apply");
    expect(run1.report.conflicts_newer_wins).toBe(1);
    expect(await st(y)).toMatchObject({ status: "active", supersedes_id: x });

    const z = await fact("Dona usa SQLite como base de datos.", "2026-03-01");
    const run2 = await runConsolidation(db, userId, "apply");
    expect(run2.report.conflicts_newer_wins).toBe(1);
    expect(await st(y)).toMatchObject({ status: "superseded" });
    expect(await st(z)).toMatchObject({ status: "active", supersedes_id: y });

    // Out-of-order revert is refused (all-or-nothing): run1 must not flip y
    // back to active, nor x, while z still supersedes y.
    const r1 = await revertConsolidationRun(db, run1.runId);
    expect(r1).toMatchObject({ restored: 0, blocked: true });
    expect(r1.drifted).toBeGreaterThanOrEqual(1);
    expect(await st(x)).toMatchObject({ status: "superseded" });
    expect(await st(y)).toMatchObject({ status: "superseded", supersedes_id: x });
    expect(await st(z)).toMatchObject({ status: "active", supersedes_id: y });

    // LIFO: revert run2, then run1 → original state, no dangling links.
    expect((await revertConsolidationRun(db, run2.runId)).blocked).toBe(false);
    expect(await st(y)).toMatchObject({ status: "active", supersedes_id: x });
    expect(await st(z)).toMatchObject({ status: "active", supersedes_id: null });
    expect(await revertConsolidationRun(db, run1.runId)).toMatchObject({ restored: 2, blocked: false });
    for (const id of [x, y, z]) expect(await st(id)).toEqual({ status: "active", canonical_id: null, supersedes_id: null });
    const conflicts = (await db.query(
      `SELECT DISTINCT resolution FROM memory_conflicts WHERE run_id IN ($1, $2)`, [run1.runId, run2.runId],
    )).rows.map((r) => r.resolution);
    expect(conflicts).toEqual(["reverted"]);
  });

  it("revert removes the sources a merge copied onto the canonical fact", async () => {
    const mk = async () => (await db.query(
      `INSERT INTO context_moments (user_id, source_mode) VALUES ($1, 'instant_capture') RETURNING id`, [userId],
    )).rows[0].id as string;
    const m1 = await mk();
    const m2 = await mk();
    const a = await fact("Fluvia cobra 30 euros al mes.", "2026-01-01", m1);
    const b = await fact("Fluvia cobra 30 euros al mes", "2026-01-02", m2);
    await db.query(`INSERT INTO memory_item_sources (memory_item_id, moment_id) VALUES ($1, $2), ($3, $4)`, [a, m1, b, m2]);
    const run = await runConsolidation(db, userId, "apply");
    expect(await st(b)).toMatchObject({ status: "merged", canonical_id: a });
    const srcs = async () => (await db.query(
      `SELECT moment_id FROM memory_item_sources WHERE memory_item_id = $1 ORDER BY moment_id`, [a],
    )).rows.map((r) => r.moment_id);
    expect(await srcs()).toHaveLength(2);
    expect((await revertConsolidationRun(db, run.runId)).sources_removed).toBe(1);
    expect(await srcs()).toEqual([m1]);
    expect(await st(b)).toMatchObject({ status: "active", canonical_id: null });
  });
});
