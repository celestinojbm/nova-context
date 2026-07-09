import {
  suggestProjectsRequestSchema,
  updateTaskRequestSchema,
  type ListTasksResponse,
  type SuggestProjectsResponse,
  type TranscriptionResponse,
} from "@nova/schema";
import {
  TranscriptionUnavailableError,
  type IntentRouter,
  type TranscriptionRouter,
} from "@nova/model-router";
import type { FastifyInstance } from "fastify";
import type { Analytics } from "./analytics.js";
import type pg from "pg";
import { z } from "zod";
import { suggestProjects } from "@nova/context-engine";

export interface M1RouteDeps {
  db: pg.Pool;
  devUserId: () => Promise<string>;
  intentRouter: IntentRouter;
  transcriptionRouter: TranscriptionRouter;
  analytics: Analytics;
}

export function registerM1Routes(app: FastifyInstance, deps: M1RouteDeps): void {
  const { db, devUserId, intentRouter, transcriptionRouter, analytics } = deps;

  /**
   * Voice transcription. Privacy contract: the uploaded audio is held in
   * memory for the duration of this request, forwarded to the configured ASR
   * provider, and discarded — never written to disk or the database. The
   * audit log records that a transcription happened, not what was said.
   */
  app.post("/v1/transcriptions", async (req, reply) => {
    if (!transcriptionRouter.available) {
      return reply.code(503).send({
        error: "transcription_unavailable",
        message:
          "No transcription provider is configured (set OPENAI_API_KEY). Type your instruction instead.",
      });
    }
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "multipart field 'audio' with the recording is required",
      });
    }
    const data = await file.toBuffer();
    if (!data.length) {
      return reply.code(400).send({ error: "invalid_request", message: "empty audio" });
    }
    const userId = await devUserId();
    try {
      const result = await transcriptionRouter.transcribe({
        data,
        mimeType: file.mimetype || "audio/webm",
        filename: file.filename || "voice.webm",
      });
      await db.query(
        `INSERT INTO audit_log (user_id, event_type, detail)
         VALUES ($1, 'transcription', $2)`,
        [
          userId,
          JSON.stringify({
            provider: result.provider,
            audio_bytes: data.length,
            transcript_chars: result.transcript.length,
          }),
        ],
      );
      const response: TranscriptionResponse = {
        transcript: result.transcript,
        provider: result.provider,
      };
      return response;
    } catch (err) {
      if (err instanceof TranscriptionUnavailableError) {
        return reply.code(503).send({ error: "transcription_unavailable" });
      }
      req.log.error({ err }, "transcription failed");
      analytics.track(userId, "transcription_failed", {});
      return reply.code(502).send({
        error: "transcription_failed",
        message: "Transcription failed. Type your instruction instead.",
      });
    }
  });

  /**
   * Project suggestion preview for the confirm card. Runs the same intent
   * parse + rule scoring the server applies at capture time, so what the UI
   * preselects is exactly what override logging compares against.
   */
  app.post("/v1/projects/suggest", async (req, reply) => {
    const parsed = suggestProjectsRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const userId = await devUserId();
    let projectHint: string | null = null;
    if (parsed.data.intent_text) {
      const { intent } = await intentRouter.parse({ text: parsed.data.intent_text });
      projectHint = intent.project_hint;
    }
    const suggestions = await suggestProjects(db, userId, {
      projectHint,
      url: parsed.data.url ?? null,
    });
    const response: SuggestProjectsResponse = { suggestions };
    return response;
  });

  app.get("/v1/tasks", async (req, reply) => {
    const query = z
      .object({
        status: z.enum(["open", "done"]).optional(),
        project_id: z.string().uuid().optional(),
      })
      .safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const userId = await devUserId();
    const conditions = ["t.user_id = $1"];
    const params: unknown[] = [userId];
    if (query.data.status) {
      params.push(query.data.status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (query.data.project_id) {
      params.push(query.data.project_id);
      conditions.push(`t.project_id = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT t.id, t.project_id, t.moment_id, t.title, t.notes, t.priority,
              t.status, t.created_at, t.completed_at,
              p.name AS project_name,
              m.source_meta->>'title' AS moment_title
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN context_moments m ON m.id = t.moment_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.created_at DESC
       LIMIT 200`,
      params,
    );
    const response: ListTasksResponse = {
      items: rows.map((r) => ({
        ...r,
        created_at: r.created_at.toISOString(),
        completed_at: r.completed_at ? r.completed_at.toISOString() : null,
      })),
    };
    return response;
  });

  app.patch("/v1/tasks/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = updateTaskRequestSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const userId = await devUserId();
    const { rows } = await db.query(
      `UPDATE tasks
       SET status = $1,
           completed_at = CASE WHEN $1 = 'done' THEN now() ELSE NULL END
       WHERE id = $2 AND user_id = $3
       RETURNING id, status, completed_at`,
      [body.data.status, params.data.id, userId],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    return {
      id: row.id,
      status: row.status,
      completed_at: row.completed_at ? row.completed_at.toISOString() : null,
    };
  });
}
