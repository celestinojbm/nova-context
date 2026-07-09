import { redactDeep } from "@nova/context-engine";
import type { LiveQaProvider } from "@nova/model-router";
import {
  liveAnswerRequestSchema,
  type ContextMoment,
  type LiveAnswerResponse,
} from "@nova/schema";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "./auth/plugin.js";
import { redactFrames } from "./image-redaction.js";
import type { Analytics } from "./analytics.js";
import type { OcrEngine } from "@nova/context-engine/visual-redaction";
import type { MediaService } from "./media/media-service.js";
import type pg from "pg";
import { z } from "zod";

export interface M3RouteDeps {
  db: pg.Pool;
  liveQa: LiveQaProvider | null;
  redactionOn: boolean;
  /** M7: OCR engine for frame masking; null = image redaction off. */
  ocr: OcrEngine | null;
  /** M8: media pipeline (null = unavailable). */
  media: MediaService | null;
  momentColumns: string;
  rowToMoment: (row: never) => ContextMoment;
  analytics: Analytics;
}

export function registerM3Routes(app: FastifyInstance, deps: M3RouteDeps): void {
  const { db, liveQa, redactionOn, ocr, media, momentColumns, analytics } = deps;
  const rowToMoment = deps.rowToMoment as (row: unknown) => ContextMoment;

  /**
   * Live Q&A (M3). Stateless: the client sends a minimized slice of its
   * local live buffer with each question; nothing is stored server-side.
   * Text context is redacted BEFORE it reaches the provider. Audit records
   * that a Q&A happened — sizes only, never content.
   */
  app.post("/v1/live/answers", async (req, reply) => {
    if (!liveQa) {
      return reply.code(503).send({
        error: "live_qa_unavailable",
        message:
          "Live Q&A needs ANTHROPIC_API_KEY with NOVA_LIVE_QA=auto on the API.",
      });
    }
    const parsed = liveAnswerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const userId = requireAuth(req).userId;
    // Redact all text legs of the context, then (M7) OCR-box mask the frames
    // themselves. A frame that cannot be redacted is DROPPED — unredacted
    // pixels never reach the model.
    const textRedacted = redactionOn
      ? {
          question: parsed.data.question,
          context: {
            ...parsed.data.context,
            title: parsed.data.context.title
              ? redactDeep(parsed.data.context.title)
              : parsed.data.context.title,
            text_snippets: redactDeep(parsed.data.context.text_snippets),
            recent_qa: redactDeep(parsed.data.context.recent_qa),
          },
        }
      : parsed.data;
    const frameResult = await redactFrames(textRedacted.context.frames, ocr);
    const request = {
      ...textRedacted,
      context: { ...textRedacted.context, frames: frameResult.frames },
    };

    try {
      const answer: LiveAnswerResponse = await liveQa.answer(request);
      await db.query(
        `INSERT INTO audit_log (user_id, event_type, detail)
         VALUES ($1, 'live.qa', $2)`,
        [
          userId,
          JSON.stringify({
            frames: request.context.frames.length,
            snippets: request.context.text_snippets.length,
            image_redaction: frameResult.redacted ? "applied" : "skipped",
            frames_masked_regions: frameResult.masked,
            frames_dropped: frameResult.dropped,
            grounding: answer.grounding,
            model: answer.model,
          }),
        ],
      );
      analytics.track(userId, "live_question_asked", {
        grounding: answer.grounding,
        frames: request.context.frames.length,
      });
      return answer;
    } catch (err) {
      req.log.error({ err }, "live qa failed");
      return reply.code(502).send({ error: "live_qa_failed" });
    }
  });

  /**
   * Export (M3): every saved Context Moment with its tasks and actions, as
   * a single JSON document. User-owned data, out in one request.
   */
  app.get("/v1/export", async (req, reply) => {
    const query = z
      .object({
        project_id: z.string().uuid().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const userId = requireAuth(req).userId;

    const momentConditions = ["user_id = $1"];
    const momentParams: unknown[] = [userId];
    if (query.data.project_id) {
      momentParams.push(query.data.project_id);
      momentConditions.push(`project_id = $${momentParams.length}`);
    }
    if (query.data.from) {
      momentParams.push(query.data.from.toISOString());
      momentConditions.push(`captured_at >= $${momentParams.length}`);
    }
    if (query.data.to) {
      momentParams.push(query.data.to.toISOString());
      momentConditions.push(`captured_at <= $${momentParams.length}`);
    }

    const [moments, tasks, actions, projects] = await Promise.all([
      db.query(
        `SELECT ${momentColumns} FROM context_moments
         WHERE ${momentConditions.join(" AND ")} ORDER BY captured_at ASC`,
        momentParams,
      ),
      db.query(
        `SELECT id, project_id, moment_id, title, notes, priority, status, created_at, completed_at
         FROM tasks WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      db.query(
        `SELECT id, moment_id, project_id, action_type, risk_tier, status, payload, result, created_at
         FROM actions WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      db.query(
        `SELECT id, name, description, created_at FROM projects
         WHERE user_id = $1 AND archived = false ORDER BY created_at ASC`,
        [userId],
      ),
    ]);
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, detail) VALUES ($1, 'export', $2)`,
      [
        userId,
        JSON.stringify({
          moments: moments.rowCount,
          tasks: tasks.rowCount,
          actions: actions.rowCount,
          filtered: Boolean(query.data.project_id || query.data.from || query.data.to),
        }),
      ],
    );
    analytics.track(userId, "export_requested", {
      moments: moments.rowCount ?? 0,
      filtered: Boolean(query.data.project_id || query.data.from || query.data.to),
    });
    reply.header(
      "content-disposition",
      `attachment; filename="nova-context-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    // M8: media rides along as redacted data URLs + metadata — the user's
    // data leaves whole, and ONLY the redacted form exists to export.
    const momentIds = moments.rows.map((r: { id: string }) => r.id);
    const mediaMap = media
      ? await media.exportForMoments(userId, momentIds)
      : new Map<string, never[]>();
    return {
      exported_at: new Date().toISOString(),
      format_version: 2,
      filters: {
        project_id: query.data.project_id ?? null,
        from: query.data.from?.toISOString() ?? null,
        to: query.data.to?.toISOString() ?? null,
      },
      projects: projects.rows,
      moments: moments.rows.map((row) => ({
        ...rowToMoment(row),
        media: mediaMap.get((row as { id: string }).id) ?? [],
      })),
      tasks: tasks.rows,
      actions: actions.rows,
    };
  });

  /**
   * Delete (M3): removes the moment AND everything derived from it — tasks,
   * actions, embeddings, entity mentions (FK cascade), memory items (FK
   * cascade). The audit records THAT a deletion happened (host + counts),
   * never the deleted content.
   */
  app.delete("/v1/context/moments/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const userId = requireAuth(req).userId;

    const existing = await db.query<{ id: string; source_meta: Record<string, unknown> }>(
      `SELECT id, source_meta FROM context_moments WHERE id = $1 AND user_id = $2`,
      [params.data.id, userId],
    );
    const moment = existing.rows[0];
    if (!moment) return reply.code(404).send({ error: "not_found" });

    // M8: blobs first (rows cascade with the moment; objects don't).
    const mediaObjects = media ? await media.deleteForMoments(userId, [moment.id]) : 0;

    const client = await db.connect();
    let deletedTasks = 0;
    let deletedActions = 0;
    try {
      await client.query("BEGIN");
      deletedTasks =
        (await client.query("DELETE FROM tasks WHERE moment_id = $1 AND user_id = $2", [
          moment.id,
          userId,
        ])).rowCount ?? 0;
      deletedActions =
        (await client.query("DELETE FROM actions WHERE moment_id = $1 AND user_id = $2", [
          moment.id,
          userId,
        ])).rowCount ?? 0;
      await client.query(
        "DELETE FROM embeddings WHERE owner_kind = 'moment' AND owner_id = $1",
        [moment.id],
      );
      // moment_media, entity_mentions, memory_items cascade via FK.
      await client.query("DELETE FROM context_moments WHERE id = $1", [moment.id]);
      await client.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'moment.delete', 'moment', $2, $3)`,
        [
          userId,
          moment.id,
          JSON.stringify({
            url_host: safeHost(moment.source_meta),
            deleted_tasks: deletedTasks,
            deleted_actions: deletedActions,
            deleted_media_objects: mediaObjects,
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
    analytics.track(userId, "delete_requested", { kind: "moment" });
    return { deleted: true, tasks: deletedTasks, actions: deletedActions, media: mediaObjects };
  });
}

function safeHost(sourceMeta: Record<string, unknown>): string | null {
  const url = sourceMeta["url"];
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
