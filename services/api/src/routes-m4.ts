import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { Analytics, productEventRequestSchema } from "./analytics.js";

export interface M4RouteDeps {
  db: pg.Pool;
  devUserId: () => Promise<string>;
  analytics: Analytics;
}

/** Friendly explanations for the audit page. Anything not listed renders
 * with its raw event type. */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  capture: "Context Moment captured",
  transcription: "Voice clip transcribed (audio not stored)",
  "project.link.override": "Project suggestion overridden by you",
  "action.propose": "Action proposed",
  "action.approve": "Action approved by you",
  "action.reject": "Action rejected by you",
  "action.execute": "Action executed",
  "action.execute.failed": "Action execution failed",
  "enrichment.completed": "Enrichment completed",
  "enrichment.failed": "Enrichment failed",
  "live.qa": "Live question answered (content not retained)",
  "live.session.start": "Live session started",
  "live.session.stop": "Live session ended (buffer destroyed)",
  "moment.delete": "Context Moment deleted (content removed)",
  "project.delete": "Project deleted",
  export: "Data export downloaded",
};

export function registerM4Routes(app: FastifyInstance, deps: M4RouteDeps): void {
  const { db, devUserId, analytics } = deps;

  /**
   * User-visible audit log (M4). detail is payload-free by contract
   * (SECURITY_PRIVACY_GOVERNANCE) — every writer stores metadata/counts only,
   * and the security suite asserts captured secrets never appear here.
   */
  app.get("/v1/audit", async (req, reply) => {
    const query = z
      .object({
        event_type: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.string().datetime({ offset: true }).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const userId = await devUserId();

    const conditions = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (query.data.event_type) {
      params.push(query.data.event_type);
      conditions.push(`event_type = $${params.length}`);
    }
    if (query.data.before) {
      params.push(query.data.before);
      conditions.push(`created_at < $${params.length}`);
    }
    params.push(query.data.limit);
    const { rows } = await db.query(
      `SELECT id, event_type, subject_kind, subject_id, detail, created_at
       FROM audit_log
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return {
      items: rows.map((r) => ({
        ...r,
        created_at: r.created_at.toISOString(),
        label: AUDIT_EVENT_LABELS[r.event_type] ?? r.event_type,
      })),
    };
  });

  /**
   * Client-side product events (extension/web). Allowlisted names, short
   * props only — captured content structurally cannot fit. Live-session
   * lifecycle events also land in the user-visible audit log.
   */
  app.post("/v1/events", async (req, reply) => {
    const parsed = productEventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_event" });
    }
    const userId = await devUserId();
    analytics.track(userId, parsed.data.event, parsed.data.props);

    if (
      parsed.data.event === "live_session_started" ||
      parsed.data.event === "live_session_stopped"
    ) {
      await db.query(
        `INSERT INTO audit_log (user_id, event_type, detail) VALUES ($1, $2, $3)`,
        [
          userId,
          parsed.data.event === "live_session_started"
            ? "live.session.start"
            : "live.session.stop",
          JSON.stringify(parsed.data.props),
        ],
      );
    }
    return reply.code(202).send({ accepted: true });
  });

  /**
   * Project deletion (M4). Removes the project and (by explicit flag)
   * everything inside it. The web UI confirms before calling; the audit
   * records counts, never content.
   */
  app.delete("/v1/projects/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({ delete_moments: z.enum(["true", "false"]).default("false") })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return reply.code(404).send({ error: "not_found" });
    }
    const userId = await devUserId();
    const project = (
      await db.query(
        `SELECT id, name FROM projects WHERE id = $1 AND user_id = $2 AND archived = false`,
        [params.data.id, userId],
      )
    ).rows[0];
    if (!project) return reply.code(404).send({ error: "not_found" });

    const deleteMoments = query.data.delete_moments === "true";
    const client = await db.connect();
    let momentCount = 0;
    let taskCount = 0;
    let actionCount = 0;
    try {
      await client.query("BEGIN");
      if (deleteMoments) {
        const momentIds = (
          await client.query<{ id: string }>(
            "SELECT id FROM context_moments WHERE project_id = $1 AND user_id = $2",
            [project.id, userId],
          )
        ).rows.map((r) => r.id);
        momentCount = momentIds.length;
        if (momentIds.length) {
          await client.query(
            `DELETE FROM embeddings WHERE owner_kind = 'moment' AND owner_id = ANY($1::uuid[])`,
            [momentIds],
          );
        }
        taskCount =
          (await client.query("DELETE FROM tasks WHERE project_id = $1 AND user_id = $2", [
            project.id,
            userId,
          ])).rowCount ?? 0;
        actionCount =
          (await client.query("DELETE FROM actions WHERE project_id = $1 AND user_id = $2", [
            project.id,
            userId,
          ])).rowCount ?? 0;
        await client.query(
          "DELETE FROM context_moments WHERE project_id = $1 AND user_id = $2",
          [project.id, userId],
        );
      }
      // Remaining references (if not deleting content) null out via FKs.
      await client.query("DELETE FROM projects WHERE id = $1", [project.id]);
      await client.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'project.delete', 'project', $2, $3)`,
        [
          userId,
          project.id,
          JSON.stringify({
            deleted_moments: momentCount,
            deleted_tasks: taskCount,
            deleted_actions: actionCount,
            content_deleted: deleteMoments,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    analytics.track(userId, "delete_requested", {
      kind: "project",
      moments: momentCount,
    });
    return {
      deleted: true,
      moments: momentCount,
      tasks: taskCount,
      actions: actionCount,
    };
  });
}
