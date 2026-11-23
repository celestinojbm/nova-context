import { redactDeep, suggestProjects, type RedactionType } from "@nova/context-engine";
import type { IntentRouter } from "@nova/model-router";
import {
  MAX_PROJECTS_PER_USER,
  createProjectRequestSchema,
  updateContextMomentRequestSchema,
  type CreateProjectResponse,
  type ParsedIntent,
  type UpdateContextMomentResponse,
} from "@nova/schema";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { requireAuth } from "./auth/plugin.js";

export interface ProjectWriteDeps {
  db: pg.Pool;
  intentRouter: IntentRouter;
  /** Misma bandera que la captura: si está activa, la intención editada se redacta. */
  redactionOn: boolean;
}

interface LockedMoment {
  id: string;
  project_id: string | null;
  intent_text: string | null;
  intent_parsed: ParsedIntent | null;
  redaction_state: "pending" | "applied" | "skipped";
  source_meta: Record<string, unknown>;
}

/**
 * Escritura aditiva de proyectos y momentos (BUILD_PLAN §5):
 *  - POST  /v1/projects             crea un proyecto.
 *  - PATCH /v1/context/moments/:id  confirma/cambia el proyecto vinculado y/o edita la intención.
 *
 * Notas de diseño:
 *  - El audit_log solo recibe ids, contadores y nombres de campos; nunca texto capturado.
 *  - Vincular un momento a un proyecto distinto de la primera sugerencia registra
 *    `project.link.override` (BUILD_PLAN §12), igual que la captura.
 *  - `memory_items.local_only` hereda del proyecto (M20a): al revincular se
 *    recalcula para que un hecho nunca quede "no local" dentro de un proyecto local.
 */
export function registerProjectWriteRoutes(app: FastifyInstance, deps: ProjectWriteDeps): void {
  const { db, intentRouter, redactionOn } = deps;

  app.post("/v1/projects", async (req, reply) => {
    const parsed = createProjectRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const userId = requireAuth(req).userId;
    const { name, description, local_only } = parsed.data;

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serializa las altas del mismo usuario: sin índice único por nombre, esto
      // evita duplicados y rebasar el tope bajo peticiones concurrentes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`projects:${userId}`]);
      const { rows: existing } = await client.query<{ n: number; dup: boolean }>(
        `SELECT count(*)::int AS n,
                coalesce(bool_or(lower(btrim(name)) = lower($2)), false) AS dup
         FROM projects WHERE user_id = $1 AND archived = false`,
        [userId, name],
      );
      if (existing[0]!.dup) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "project_exists" });
      }
      if (existing[0]!.n >= MAX_PROJECTS_PER_USER) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "project_limit_reached", limit: MAX_PROJECTS_PER_USER });
      }
      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO projects (user_id, name, description, local_only)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [userId, name, description, local_only],
      );
      const row = rows[0]!;
      await client.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'project.create', 'project', $2, $3)`,
        [userId, row.id, JSON.stringify({ local_only, has_description: Boolean(description) })],
      );
      await client.query("COMMIT");
      const response: CreateProjectResponse = {
        id: row.id,
        name,
        description,
        local_only,
        created_at: row.created_at.toISOString(),
      };
      return reply.code(201).send(response);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  app.patch("/v1/context/moments/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const parsed = updateContextMomentRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const userId = requireAuth(req).userId;
    const body = parsed.data;

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<LockedMoment>(
        `SELECT id, project_id, intent_text, intent_parsed, redaction_state, source_meta
         FROM context_moments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [params.data.id, userId],
      );
      const moment = found.rows[0];
      if (!moment) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "not_found" });
      }

      let newProjectId = moment.project_id;
      let newLocalOnly = false;
      if (body.project_id !== undefined) {
        newProjectId = body.project_id;
        if (body.project_id) {
          const proj = await client.query<{ local_only: boolean }>(
            "SELECT local_only FROM projects WHERE id = $1 AND user_id = $2 AND archived = false",
            [body.project_id, userId],
          );
          if (!proj.rows[0]) {
            await client.query("ROLLBACK");
            return reply.code(400).send({
              error: "invalid_request",
              issues: [{ path: "project_id", message: "unknown project" }],
            });
          }
          newLocalOnly = proj.rows[0].local_only;
        }
      }

      let newIntentText = moment.intent_text;
      let newIntentParsed = moment.intent_parsed;
      let redactionTally: Map<RedactionType, number> | null = null;
      if (body.intent_text !== undefined) {
        let text = body.intent_text?.trim() ? body.intent_text : null;
        if (text && redactionOn) {
          redactionTally = new Map();
          text = redactDeep(text, redactionTally);
        }
        if (text !== moment.intent_text) {
          newIntentText = text;
          if (text) {
            const projectNames = (
              await client.query<{ name: string }>(
                "SELECT name FROM projects WHERE user_id = $1 AND archived = false",
                [userId],
              )
            ).rows.map((r) => r.name);
            const result = await intentRouter.parse({
              text,
              pageTitle: (moment.source_meta["title"] as string | undefined) ?? null,
              knownProjects: projectNames,
            });
            newIntentParsed = result.intent;
          } else {
            newIntentParsed = null;
          }
        }
      }

      const changed: UpdateContextMomentResponse["changed"] = [];
      const projectChanged = newProjectId !== moment.project_id;
      const intentChanged = newIntentText !== moment.intent_text;
      if (projectChanged) changed.push("project_id");
      if (intentChanged) changed.push("intent_text");

      if (changed.length) {
        await client.query(
          `UPDATE context_moments
           SET project_id = $2, intent_text = $3, intent_parsed = $4
           WHERE id = $1`,
          [
            moment.id,
            newProjectId,
            newIntentText,
            newIntentParsed ? JSON.stringify(newIntentParsed) : null,
          ],
        );
      }

      if (projectChanged) {
        // Tareas y acciones del momento que seguían su vínculo anterior lo siguen.
        await client.query(
          `UPDATE tasks SET project_id = $3
           WHERE moment_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $4`,
          [moment.id, userId, newProjectId, moment.project_id],
        );
        await client.query(
          `UPDATE actions SET project_id = $3, updated_at = now()
           WHERE moment_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $4`,
          [moment.id, userId, newProjectId, moment.project_id],
        );
        await client.query(
          `UPDATE memory_items SET local_only = $3
           WHERE moment_id = $1 AND user_id = $2`,
          [moment.id, userId, newLocalOnly],
        );
      }

      if (changed.length) {
        await client.query(
          `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
           VALUES ($1, 'moment.update', 'moment', $2, $3)`,
          [
            userId,
            moment.id,
            JSON.stringify({
              fields: changed,
              from_project_id: projectChanged ? moment.project_id : undefined,
              to_project_id: projectChanged ? newProjectId : undefined,
              text_redaction: intentChanged && newIntentText ? (redactionOn ? "applied" : "skipped") : undefined,
              redactions: redactionTally ? Object.fromEntries(redactionTally) : undefined,
            }),
          ],
        );
      }
      await client.query("COMMIT");

      // Registro de override (BUILD_PLAN §12): fuera de la transacción de escritura —
      // es una señal de ranking, no puede bloquear ni revertir la edición del usuario.
      if (projectChanged && newProjectId) {
        const suggestions = await suggestProjects(db, userId, {
          projectHint: newIntentParsed?.project_hint ?? null,
          url: (moment.source_meta["url"] as string | undefined) ?? null,
        });
        const top = suggestions[0];
        if (top && top.id !== newProjectId) {
          await db.query(
            `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
             VALUES ($1, 'project.link.override', 'moment', $2, $3)`,
            [
              userId,
              moment.id,
              JSON.stringify({
                chosen_project_id: newProjectId,
                suggested_project_id: top.id,
                suggested_confidence: top.confidence,
              }),
            ],
          );
        }
      }

      const response: UpdateContextMomentResponse = {
        id: moment.id,
        project_id: newProjectId,
        intent_text: newIntentText,
        intent_parsed: newIntentParsed,
        redaction_state: moment.redaction_state,
        changed,
      };
      return response;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}
