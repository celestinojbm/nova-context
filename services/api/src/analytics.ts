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
}
