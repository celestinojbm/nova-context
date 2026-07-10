import type pg from "pg";
import { runMediaCleanup, type CleanupReport } from "../media/cleanup.js";
import type { ObjectStore } from "../media/object-store.js";

/**
 * M11 scheduled/operator maintenance. One entry point, sections isolated —
 * a failing section is reported, never fatal to the rest. DRY-RUN is the
 * default; nothing destructive happens without `apply`. Every run (either
 * mode) is recorded in ops_maintenance_runs so the status page can show
 * when maintenance last happened. Counts only — never content.
 *
 * Sections:
 *   - media: orphan cleanup + delete-queue drain (M9 machinery)
 *   - sessions: revoked/expired session rows older than the retention window
 *   - pairing codes: expired or already-claimed codes
 *   - oauth states: expired or already-used states
 *   - password resets: expired or already-used reset tokens
 *   - failed actions: VISIBILITY only (count + recent reasons), never deleted
 *   - product events: pruned ONLY when pruneEventsDays is explicitly set
 */

export interface MaintenanceOptions {
  /** false = dry run: report what WOULD be removed, remove nothing. */
  apply: boolean;
  /** Orphan-blob age guard passed through to media cleanup. */
  minAgeMinutes?: number;
  /** When set, product events older than N days are pruned (apply mode). */
  pruneEventsDays?: number | null;
  /** Days a dead (revoked/expired) session row is kept before removal. */
  sessionRetentionDays?: number;
}

export interface MaintenanceReport {
  mode: "dry-run" | "apply";
  media: CleanupReport | { error: string };
  stale_sessions: { count: number; deleted: number } | { error: string };
  expired_pairing_codes: { count: number; deleted: number } | { error: string };
  expired_oauth_states: { count: number; deleted: number } | { error: string };
  expired_password_resets: { count: number; deleted: number } | { error: string };
  failed_actions: { count: number; recent: Array<{ id: string; reason: string; at: string }> } | { error: string };
  product_events: { count: number; deleted: number; prune_days: number | null } | { error: string };
}

async function section<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: (err as Error).message.slice(0, 200) };
  }
}

/** Count matching rows; delete them only in apply mode. */
async function sweep(
  db: pg.Pool,
  apply: boolean,
  where: string,
  table: string,
  params: unknown[] = [],
): Promise<{ count: number; deleted: number }> {
  const { rows } = await db.query(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  );
  const count = Number((rows[0] as { n: string }).n);
  if (!apply || count === 0) return { count, deleted: 0 };
  const del = await db.query(`DELETE FROM ${table} WHERE ${where}`, params);
  return { count, deleted: del.rowCount ?? 0 };
}

export async function runMaintenance(
  db: pg.Pool,
  store: ObjectStore,
  opts: MaintenanceOptions,
): Promise<MaintenanceReport> {
  const apply = opts.apply;
  const sessionDays = opts.sessionRetentionDays ?? 7;

  const report: MaintenanceReport = {
    mode: apply ? "apply" : "dry-run",
    media: await section(() =>
      runMediaCleanup(db, store, {
        deleteOrphans: apply,
        minAgeMinutes: opts.minAgeMinutes ?? 60,
      }),
    ),
    // Dead sessions: revoked or expired, past the retention window (the
    // window keeps the sessions UI/audit trail useful for a few days).
    stale_sessions: await section(() =>
      sweep(
        db,
        apply,
        `(revoked_at IS NOT NULL OR expires_at < now())
           AND coalesce(revoked_at, expires_at) < now() - ($1 || ' days')::interval`,
        "sessions",
        [String(sessionDays)],
      ),
    ),
    expired_pairing_codes: await section(() =>
      sweep(db, apply, `expires_at < now() OR claimed_at IS NOT NULL`, "pairing_codes"),
    ),
    expired_oauth_states: await section(() =>
      sweep(db, apply, `expires_at < now() OR used_at IS NOT NULL`, "oauth_states"),
    ),
    expired_password_resets: await section(() =>
      sweep(db, apply, `expires_at < now() OR used_at IS NOT NULL`, "password_resets"),
    ),
    // Failed actions are USER data awaiting a decision — maintenance only
    // surfaces them (reasons are worker error codes, never captured content).
    failed_actions: await section(async () => {
      const { rows } = await db.query(
        `SELECT id, result->>'error' AS reason, updated_at
         FROM actions WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5`,
      );
      const count = await db.query(`SELECT count(*) AS n FROM actions WHERE status = 'failed'`);
      return {
        count: Number((count.rows[0] as { n: string }).n),
        recent: rows.map((r) => ({
          id: r.id as string,
          reason: ((r.reason as string | null) ?? "unknown").slice(0, 120),
          at: (r.updated_at as Date).toISOString(),
        })),
      };
    }),
    product_events: await section(async () => {
      if (opts.pruneEventsDays == null) {
        const { rows } = await db.query(`SELECT count(*) AS n FROM product_events`);
        return { count: Number((rows[0] as { n: string }).n), deleted: 0, prune_days: null };
      }
      const result = await sweep(
        db,
        apply,
        `created_at < now() - ($1 || ' days')::interval`,
        "product_events",
        [String(opts.pruneEventsDays)],
      );
      return { ...result, prune_days: opts.pruneEventsDays };
    }),
  };

  await db.query(
    `INSERT INTO ops_maintenance_runs (mode, report) VALUES ($1, $2)`,
    [report.mode, JSON.stringify(report)],
  );
  return report;
}
