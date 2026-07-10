import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { feedbackRequestSchema, type FeedbackItem } from "@nova/schema";
import type { Analytics } from "./analytics.js";
import { requireAuth } from "./auth/plugin.js";
import type { RateLimiter } from "./auth/rate-limit.js";

/**
 * M13: private-alpha feedback intake.
 *
 *   POST /v1/feedback   — submit one item (category allowlist + text-only
 *                         message; pasted data URLs are rejected upstream
 *                         by the shared zod contract)
 *   GET  /v1/feedback   — the caller's own items (confirmation UI)
 *
 * Operator view: `pnpm --filter @nova/api ops:report` lists the latest
 * items with excerpts. The audit row and product event record the CATEGORY
 * only — never the message — so feedback text lives in exactly one place
 * the user can see and the account delete cascade removes.
 */

export interface FeedbackRouteDeps {
  db: pg.Pool;
  analytics: Analytics;
  rateLimiter: RateLimiter;
}

export function registerFeedbackRoutes(
  app: FastifyInstance,
  { db, analytics, rateLimiter }: FeedbackRouteDeps,
): void {
  app.post("/v1/feedback", async (req, reply) => {
    const userId = requireAuth(req).userId;
    const parsed = feedbackRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_feedback",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    if (!(await rateLimiter.allow(`feedback:${userId}`))) {
      return reply.code(429).send({ error: "rate_limited" });
    }

    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO alpha_feedback (user_id, category, message)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [userId, parsed.data.category, parsed.data.message],
    );
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
       VALUES ($1, 'feedback.submitted', 'feedback', $2, $3)`,
      [userId, rows[0]!.id, JSON.stringify({ category: parsed.data.category })],
    );
    analytics.track(userId, "feedback_submitted", { category: parsed.data.category });
    req.log.info({ category: parsed.data.category }, "feedback_submitted");

    return reply.code(201).send({
      id: rows[0]!.id,
      category: parsed.data.category,
      status: "new",
      created_at: rows[0]!.created_at.toISOString(),
    });
  });

  app.get("/v1/feedback", async (req) => {
    const userId = requireAuth(req).userId;
    const { rows } = await db.query<{
      id: string;
      category: FeedbackItem["category"];
      message: string;
      status: FeedbackItem["status"];
      created_at: Date;
    }>(
      `SELECT id, category, message, status, created_at FROM alpha_feedback
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return {
      items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    };
  });
}
