import type pg from "pg";
import { z } from "zod";

/**
 * Privacy-preserving funnel instrumentation (M4). Structural guarantees:
 *   - only allowlisted event names are accepted (unknown → rejected);
 *   - prop values are numbers, booleans, or short enum-ish strings (≤40
 *     chars) — long free text (i.e. captured content) cannot fit;
 *   - emission is fire-and-forget and never fails the hosting request.
 */

export const PRODUCT_EVENTS = [
  "extension_opened",
  "instant_capture_started",
  "instant_capture_saved",
  "live_session_started",
  "live_session_stopped",
  "live_question_asked",
  "live_moment_saved",
  "search_performed",
  "action_proposed",
  "action_approved",
  "action_rejected",
  "export_requested",
  "delete_requested",
  "capture_failed",
  "enrichment_failed",
  "transcription_failed",
  "onboarding_completed",
  "consent_reset",
  // M13 alpha usage loop additions. Account lifecycle is deliberately NOT
  // an event here: product_events cascade-delete with the account, so the
  // durable lifecycle record is account_tombstones (M10).
  "task_created",
  "notion_action_executed",
  "feedback_submitted",
] as const;
export type ProductEvent = (typeof PRODUCT_EVENTS)[number];

export const productEventRequestSchema = z
  .object({
    event: z.enum(PRODUCT_EVENTS),
    props: z
      .record(
        z.union([z.number().finite(), z.boolean(), z.string().max(40)]),
      )
      .default({}),
  })
  .strict();

export class Analytics {
  constructor(
    private readonly db: pg.Pool,
    private readonly enabled: boolean,
  ) {}

  /** Fire-and-forget; analytics must never break product flows. */
  track(
    userId: string,
    event: ProductEvent,
    props: Record<string, number | boolean | string> = {},
  ): void {
    if (!this.enabled) return;
    const safeProps: Record<string, number | boolean | string> = {};
    for (const [k, v] of Object.entries(props)) {
      safeProps[k.slice(0, 40)] = typeof v === "string" ? v.slice(0, 40) : v;
    }
    void this.db
      .query(
        `INSERT INTO product_events (user_id, event, props) VALUES ($1, $2, $3)`,
        [userId, event, JSON.stringify(safeProps)],
      )
      .catch(() => {
        /* dropped on error, by design */
      });
  }

  /**
   * Retrieval instrumentation (migration 0020, THEORY §6 falsification test):
   * record that a TEXT-QUERY search returned these moments, in rank order.
   * One upserted row per moment — ids, counters and timestamps only, never
   * the query. Same off-switch and fire-and-forget contract as `track`: the
   * returned promise never rejects, and callers must not await it on the
   * request path. The join re-checks ownership, so a foreign or just-deleted
   * id is skipped instead of failing the batch.
   */
  trackRetrievals(userId: string, momentIdsInRankOrder: readonly string[]): Promise<void> {
    if (!this.enabled || momentIdsInRankOrder.length === 0) return Promise.resolve();
    const ranks = momentIdsInRankOrder.map((_, i) => i + 1);
    return this.db
      .query(
        `INSERT INTO moment_retrievals (moment_id, user_id, best_rank)
         SELECT m.id, m.user_id, r.rank
         FROM unnest($2::uuid[], $3::int[]) AS r(id, rank)
         JOIN context_moments m ON m.id = r.id AND m.user_id = $1
         ON CONFLICT (moment_id) DO UPDATE
           SET search_hits = moment_retrievals.search_hits + 1,
               best_rank = least(moment_retrievals.best_rank, EXCLUDED.best_rank),
               last_retrieved_at = now()`,
        [userId, [...momentIdsInRankOrder], ranks],
      )
      .then(
        () => undefined,
        () => {
          /* dropped on error, by design */
        },
      );
  }
}
