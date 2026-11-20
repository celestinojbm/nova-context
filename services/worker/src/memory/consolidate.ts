import type pg from "pg";
import { classifyPair, THRESHOLDS, type Thresholds } from "./consolidation-rules.js";

/**
 * M20c: one consolidation run for one user (docs/design/memoria-m20.md §1.3).
 * - dry-run (default): decides and records counts in ops_maintenance_runs
 *   (job='memory-consolidation'); touches no memory_items.
 * - apply: duplicates → 'merged' (+canonical_id, sources joined to the
 *   canonical); conflicts → newest wins, older 'superseded' (newer gets
 *   supersedes_id) and memory_conflicts(resolution='newer_wins'). If either
 *   fact has author='user' nothing is resolved: the model fact (if any) is
 *   marked 'contested' and the conflict stays 'open'. User facts are never
 *   modified. Every change is logged for revertConsolidationRun(run_id).
 * Pairs never cross namespaces. Candidates come from pg_trgm similarity().
 * Serialized per user with pg_advisory_xact_lock. No LLM, no embeddings.
 */
export type ConsolidationMode = "dry-run" | "apply";
export const CONSOLIDATION_JOB = "memory-consolidation";

export interface ConsolidationReport {
  candidates: number;
  merges: number;
  conflicts_newer_wins: number;
  conflicts_contested: number;
  skipped_user_merges: number;
}

interface Item { id: string; content: string; author: string; valid_from: Date | null; created_at: Date }
interface Pair { a: string; b: string; sim: number }

export async function runConsolidation(
  db: pg.Pool,
  userId: string,
  mode: ConsolidationMode = "dry-run",
  t: Thresholds = THRESHOLDS,
): Promise<{ runId: string; report: ConsolidationReport }> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('memory-consolidation:' || $1))", [userId]);
    const items = new Map<string, Item>();
    for (const r of (
      await c.query<Item>(
        `SELECT id, content, author, valid_from, created_at FROM memory_items
         WHERE user_id = $1 AND status = 'active' AND layer = 'semantic'`,
        [userId],
      )
    ).rows) items.set(r.id, r);
    const pairs = (
      await c.query<Pair>(
        `SELECT a.id AS a, b.id AS b, similarity(a.content, b.content) AS sim
         FROM memory_items a JOIN memory_items b
           ON b.user_id = a.user_id AND a.id < b.id
          AND a.namespace_id IS NOT DISTINCT FROM b.namespace_id
          AND (a.content_hash = b.content_hash OR similarity(a.content, b.content) >= $2)
         WHERE a.user_id = $1 AND a.status = 'active' AND b.status = 'active'
           AND a.layer = 'semantic' AND b.layer = 'semantic'
         ORDER BY sim DESC`,
        [userId, t.candidate],
      )
    ).rows;

    const report: ConsolidationReport = {
      candidates: pairs.length, merges: 0, conflicts_newer_wins: 0, conflicts_contested: 0, skipped_user_merges: 0,
    };
    const run = await c.query<{ id: string }>(
      `INSERT INTO ops_maintenance_runs (mode, report, job, user_id) VALUES ($1, '{}', $2, $3) RETURNING id`,
      [mode, CONSOLIDATION_JOB, userId],
    );
    const runId = run.rows[0]!.id;
    const touched = new Set<string>();
    const time = (i: Item) => (i.valid_from ?? i.created_at).getTime();

    const change = async (id: string, status: string, set: { canonical_id?: string; supersedes_id?: string }) => {
      if (mode !== "apply") return;
      // Log previous AND written values: revert only restores rows still in
      // the state this run left them in (see revertConsolidationRun).
      await c.query(
        `INSERT INTO memory_consolidation_changes
           (run_id, memory_item_id, prev_status, new_status, prev_canonical_id, prev_supersedes_id, new_canonical_id, new_supersedes_id)
         SELECT $1, id, status, $3, canonical_id, supersedes_id, COALESCE($4, canonical_id), COALESCE($5, supersedes_id)
         FROM memory_items WHERE id = $2`,
        [runId, id, status, set.canonical_id ?? null, set.supersedes_id ?? null],
      );
      await c.query(
        `UPDATE memory_items SET status = $2,
           canonical_id = COALESCE($3, canonical_id), supersedes_id = COALESCE($4, supersedes_id)
         WHERE id = $1`,
        [id, status, set.canonical_id ?? null, set.supersedes_id ?? null],
      );
    };

    for (const p of pairs) {
      if (touched.has(p.a) || touched.has(p.b)) continue;
      const A = items.get(p.a);
      const B = items.get(p.b);
      if (!A || !B) continue;
      const [older, newer] = time(A) <= time(B) ? [A, B] : [B, A];
      const d = classifyPair(older.content, newer.content, t, Number(p.sim));
      if (d.relation === "merge") {
        const userO = older.author === "user";
        const userN = newer.author === "user";
        if (userO && userN) { report.skipped_user_merges++; continue; }
        const [canon, dup] = userN ? [newer, older] : [older, newer];
        report.merges++;
        touched.add(dup.id);
        await change(dup.id, "merged", { canonical_id: canon.id });
        if (mode === "apply") {
          // Only rows actually inserted are logged, so revert removes exactly these.
          await c.query(
            `WITH copied AS (
               INSERT INTO memory_item_sources (memory_item_id, moment_id)
               SELECT $2, moment_id FROM memory_item_sources WHERE memory_item_id = $3
               ON CONFLICT DO NOTHING RETURNING memory_item_id, moment_id)
             INSERT INTO memory_consolidation_sources (run_id, memory_item_id, moment_id)
             SELECT $1, memory_item_id, moment_id FROM copied`,
            [runId, canon.id, dup.id],
          );
        }
      } else if (d.relation === "conflict") {
        touched.add(older.id); touched.add(newer.id);
        const userInvolved = older.author === "user" || newer.author === "user";
        if (userInvolved) {
          report.conflicts_contested++;
          for (const it of [older, newer]) if (it.author !== "user") await change(it.id, "contested", {});
        } else {
          report.conflicts_newer_wins++;
          await change(older.id, "superseded", {});
          await change(newer.id, "active", { supersedes_id: older.id });
        }
        if (mode === "apply") {
          await c.query(
            `INSERT INTO memory_conflicts (user_id, older_id, newer_id, detected_by, resolution, run_id)
             VALUES ($1, $2, $3, 'rule', $4, $5)`,
            [userId, older.id, newer.id, userInvolved ? "open" : "newer_wins", runId],
          );
        }
      }
    }
    await c.query(`UPDATE ops_maintenance_runs SET report = $2 WHERE id = $1`, [runId, JSON.stringify(report)]);
    await c.query("COMMIT");
    return { runId, report };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export interface RevertResult {
  restored: number;
  /** Logged rows whose current state no longer matches what this run wrote. */
  drifted: number;
  /** True when nothing was reverted because of drift: revert later runs first. */
  blocked: boolean;
  sources_removed: number;
}

/**
 * Undo an applied run: restores logged statuses/links, removes the sources the
 * run copied onto canonical facts, conflicts → 'reverted'. All-or-nothing: if
 * any fact changed after this run (typically a later run superseded it), the
 * revert is refused (`blocked`) instead of resurrecting contradicted facts;
 * revert the later runs first (LIFO). Idempotent.
 */
export async function revertConsolidationRun(db: pg.Pool, runId: string): Promise<RevertResult> {
  const none: RevertResult = { restored: 0, drifted: 0, blocked: false, sources_removed: 0 };
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const run = await c.query<{ reverted_at: Date | null; user_id: string | null }>(
      `SELECT reverted_at, user_id FROM ops_maintenance_runs WHERE id = $1 AND job = $2 FOR UPDATE`,
      [runId, CONSOLIDATION_JOB],
    );
    if (!run.rows[0] || run.rows[0].reverted_at) { await c.query("ROLLBACK"); return none; }
    // Same lock as runConsolidation: no run can interleave with the revert.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('memory-consolidation:' || $1))", [run.rows[0].user_id ?? ""]);
    const drift = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_consolidation_changes ch JOIN memory_items mi ON mi.id = ch.memory_item_id
       WHERE ch.run_id = $1 AND NOT (mi.status = ch.new_status
         AND mi.canonical_id IS NOT DISTINCT FROM ch.new_canonical_id
         AND mi.supersedes_id IS NOT DISTINCT FROM ch.new_supersedes_id)`,
      [runId],
    );
    const drifted = drift.rows[0]?.n ?? 0;
    if (drifted > 0) { await c.query("ROLLBACK"); return { ...none, drifted, blocked: true }; }
    const res = await c.query(
      `UPDATE memory_items mi SET status = ch.prev_status,
              canonical_id = ch.prev_canonical_id, supersedes_id = ch.prev_supersedes_id
       FROM memory_consolidation_changes ch
       WHERE ch.run_id = $1 AND ch.memory_item_id = mi.id`,
      [runId],
    );
    const src = await c.query(
      `DELETE FROM memory_item_sources s USING memory_consolidation_sources cs
       WHERE cs.run_id = $1 AND s.memory_item_id = cs.memory_item_id AND s.moment_id = cs.moment_id`,
      [runId],
    );
    await c.query(
      `UPDATE memory_conflicts SET resolution = 'reverted' WHERE run_id = $1 AND resolution IN ('open','newer_wins')`,
      [runId],
    );
    await c.query(`UPDATE ops_maintenance_runs SET reverted_at = now() WHERE id = $1`, [runId]);
    await c.query("COMMIT");
    return { restored: res.rowCount ?? 0, drifted: 0, blocked: false, sources_removed: src.rowCount ?? 0 };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
