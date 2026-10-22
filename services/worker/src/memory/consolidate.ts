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
      await c.query(
        `INSERT INTO memory_consolidation_changes (run_id, memory_item_id, prev_status, new_status, prev_canonical_id, prev_supersedes_id)
         SELECT $1, id, status, $3, canonical_id, supersedes_id FROM memory_items WHERE id = $2`,
        [runId, id, status],
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
          await c.query(
            `INSERT INTO memory_item_sources (memory_item_id, moment_id)
             SELECT $1, moment_id FROM memory_item_sources WHERE memory_item_id = $2 ON CONFLICT DO NOTHING`,
            [canon.id, dup.id],
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
          if (mode === "apply") {
            await c.query(
              `INSERT INTO memory_consolidation_changes (run_id, memory_item_id, prev_status, new_status, prev_canonical_id, prev_supersedes_id)
               SELECT $1, id, status, status, canonical_id, supersedes_id FROM memory_items WHERE id = $2
               ON CONFLICT DO NOTHING`,
              [runId, newer.id],
            );
            await c.query(`UPDATE memory_items SET supersedes_id = $2 WHERE id = $1`, [newer.id, older.id]);
          }
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

/** Undo an applied run: restores logged statuses/links, conflicts → 'user_resolved'. Idempotent. */
export async function revertConsolidationRun(db: pg.Pool, runId: string): Promise<{ restored: number }> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const run = await c.query<{ reverted_at: Date | null }>(
      `SELECT reverted_at FROM ops_maintenance_runs WHERE id = $1 AND job = $2 FOR UPDATE`,
      [runId, CONSOLIDATION_JOB],
    );
    if (!run.rows[0] || run.rows[0].reverted_at) { await c.query("ROLLBACK"); return { restored: 0 }; }
    const res = await c.query(
      `UPDATE memory_items mi SET status = ch.prev_status,
              canonical_id = ch.prev_canonical_id, supersedes_id = ch.prev_supersedes_id
       FROM memory_consolidation_changes ch
       WHERE ch.run_id = $1 AND ch.memory_item_id = mi.id`,
      [runId],
    );
    await c.query(
      `UPDATE memory_conflicts SET resolution = 'user_resolved' WHERE run_id = $1 AND resolution IN ('open','newer_wins')`,
      [runId],
    );
    await c.query(`UPDATE ops_maintenance_runs SET reverted_at = now() WHERE id = $1`, [runId]);
    await c.query("COMMIT");
    return { restored: res.rowCount ?? 0 };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
