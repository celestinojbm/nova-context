import type { IngestStatusItem, IngestStatusResponse } from "@nova/schema";
import { ingestStatusQuerySchema, visibleIngest } from "@nova/schema";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAuth } from "./auth/plugin.js";

/**
 * GET /v1/context/ingest-status — list moments whose ingest/enrichment is
 * still pending (with reason), failed (code + message), or expired.
 * Filterable by project_id. Does not rewrite stored statuses.
 */
export function registerIngestStatusRoutes(app: FastifyInstance, db: pg.Pool): void {
  app.get("/v1/context/ingest-status", async (req, reply) => {
    const parsed = ingestStatusQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { project_id, status, limit } = parsed.data;
    const userId = requireAuth(req).userId;

    const conditions = [
      "user_id = $1",
      "enrichment_status IN ('pending', 'processing', 'failed')",
    ];
    const params: unknown[] = [userId];
    if (project_id) {
      params.push(project_id);
      conditions.push(`project_id = $${params.length}`);
    }
    params.push(limit);

    const { rows } = await db.query<{
      id: string;
      project_id: string | null;
      enrichment_status: string;
      enrichment_wait_reason: string | null;
      enrichment_error_code: string | null;
      enrichment_error: string | null;
      enrichment_expires_at: Date | null;
      captured_at: Date;
    }>(
      `SELECT id, project_id, enrichment_status, enrichment_wait_reason,
              enrichment_error_code, enrichment_error, enrichment_expires_at, captured_at
       FROM context_moments
       WHERE ${conditions.join(" AND ")}
       ORDER BY captured_at DESC
       LIMIT $${params.length}`,
      params,
    );

    const items: IngestStatusItem[] = [];
    for (const row of rows) {
      const vis = visibleIngest(row);
      if (!vis.status) continue;
      if (status && vis.status !== status) continue;
      items.push({
        moment_id: row.id,
        project_id: row.project_id,
        status: vis.status,
        wait_reason: vis.wait_reason,
        error_code: vis.error_code,
        error_message: vis.error_message,
        captured_at: row.captured_at.toISOString(),
        expires_at: vis.expires_at,
      });
    }
    const response: IngestStatusResponse = { items };
    return response;
  });
}
