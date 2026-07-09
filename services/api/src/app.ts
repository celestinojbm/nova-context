import cors from "@fastify/cors";
import {
  createContextMomentRequestSchema,
  type ContextMoment,
  type CreateContextMomentResponse,
  type ListContextMomentsResponse,
} from "@nova/schema";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import type { Env } from "./env.js";

const DEV_USER_EMAIL = "dev@nova.local";

interface MomentRow {
  id: string;
  project_id: string | null;
  source_mode: "instant_capture" | "live_context";
  source_meta: Record<string, unknown>;
  payload: Record<string, unknown>;
  extracted_text: string | null;
  intent_text: string | null;
  summary: string | null;
  captured_at: Date;
  redaction_state: "pending" | "applied" | "skipped";
}

function rowToMoment(row: MomentRow): ContextMoment {
  return {
    id: row.id,
    project_id: row.project_id,
    source_mode: row.source_mode,
    source_meta: row.source_meta,
    payload: row.payload,
    extracted_text: row.extracted_text,
    intent_text: row.intent_text,
    summary: row.summary,
    captured_at: row.captured_at.toISOString(),
    redaction_state: row.redaction_state,
  };
}

export interface BuildAppOptions {
  env: Env;
  pool?: pg.Pool;
}

export async function buildApp({ env, pool }: BuildAppOptions): Promise<FastifyInstance> {
  const db = pool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const app = Fastify({
    logger: true,
    // Screenshot data URLs ride in the JSON body; default 1MB is too small.
    bodyLimit: 4 * 1024 * 1024,
  });

  // The extension (chrome-extension:// origin) and the web app both call the
  // API cross-origin in dev. M0 is single-user local; tighten with real auth.
  await app.register(cors, { origin: true });

  if (!pool) {
    app.addHook("onClose", async () => {
      await db.end();
    });
  }

  // Optional shared-token auth for M0. Real OAuth 2.1 + scopes is out of scope
  // (BUILD_PLAN §14: no public API yet); this keeps a deployed dev instance
  // from being an open write endpoint.
  app.addHook("onRequest", async (req, reply) => {
    if (!env.NOVA_API_TOKEN) return;
    if (!req.url.startsWith("/v1/")) return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${env.NOVA_API_TOKEN}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // M0 is single-user: every request acts as the seeded dev user.
  async function devUserId(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1",
      [DEV_USER_EMAIL],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(
        `Dev user missing — run migrations (pnpm db:migrate) to seed ${DEV_USER_EMAIL}`,
      );
    }
    return row.id;
  }

  app.get("/healthz", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  app.post("/v1/context/moments", async (req, reply) => {
    const parsed = createContextMomentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const body = parsed.data;
    const userId = await devUserId();

    if (body.project_id) {
      const { rowCount } = await db.query(
        "SELECT 1 FROM projects WHERE id = $1 AND user_id = $2",
        [body.project_id, userId],
      );
      if (!rowCount) {
        return reply.code(400).send({
          error: "invalid_request",
          issues: [{ path: "project_id", message: "unknown project" }],
        });
      }
    }

    const { rows } = await db.query<MomentRow>(
      `INSERT INTO context_moments
         (user_id, project_id, source_mode, source_meta, payload, extracted_text, intent_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, project_id, source_mode, source_meta, payload,
                 extracted_text, intent_text, summary, captured_at, redaction_state`,
      [
        userId,
        body.project_id ?? null,
        body.source_mode,
        JSON.stringify(body.source_meta),
        JSON.stringify(body.payload),
        body.extracted_text ?? null,
        body.intent_text ?? null,
      ],
    );
    const moment = rowToMoment(rows[0]!);

    // Audit trail from day one (SECURITY_PRIVACY_GOVERNANCE): event metadata
    // only — no payload, no extracted text.
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
       VALUES ($1, 'capture', 'moment', $2, $3)`,
      [
        userId,
        moment.id,
        JSON.stringify({
          source_mode: moment.source_mode,
          url_host: safeHost(moment.source_meta),
        }),
      ],
    );

    const response: CreateContextMomentResponse = {
      id: moment.id,
      project_id: moment.project_id,
      summary: null,
      captured_at: moment.captured_at,
      redaction_state: moment.redaction_state,
      // No enrichment worker in M0 — reported honestly so clients built now
      // keep working when it arrives in M2.
      enrichment: { status: "skipped", job_id: null },
      suggested_projects: [],
      links: { self: `/v1/context/moments/${moment.id}` },
    };
    return reply.code(201).send(response);
  });

  const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().datetime({ offset: true }).optional(),
    project_id: z.string().uuid().optional(),
  });

  app.get("/v1/context/moments", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { limit, before, project_id } = parsed.data;
    const userId = await devUserId();

    const conditions = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (before) {
      params.push(before);
      conditions.push(`captured_at < $${params.length}`);
    }
    if (project_id) {
      params.push(project_id);
      conditions.push(`project_id = $${params.length}`);
    }
    params.push(limit);

    const { rows } = await db.query<MomentRow>(
      `SELECT id, project_id, source_mode, source_meta, payload,
              extracted_text, intent_text, summary, captured_at, redaction_state
       FROM context_moments
       WHERE ${conditions.join(" AND ")}
       ORDER BY captured_at DESC
       LIMIT $${params.length}`,
      params,
    );
    const items = rows.map(rowToMoment);
    const response: ListContextMomentsResponse = {
      items,
      next_before: items.length === limit ? items[items.length - 1]!.captured_at : null,
    };
    return response;
  });

  app.get("/v1/context/moments/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) {
      return reply.code(404).send({ error: "not_found" });
    }
    const userId = await devUserId();
    const { rows } = await db.query<MomentRow>(
      `SELECT id, project_id, source_mode, source_meta, payload,
              extracted_text, intent_text, summary, captured_at, redaction_state
       FROM context_moments
       WHERE id = $1 AND user_id = $2`,
      [params.data.id, userId],
    );
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: "not_found" });
    }
    return rowToMoment(row);
  });

  app.get("/v1/projects", async () => {
    const userId = await devUserId();
    const { rows } = await db.query(
      `SELECT id, name, description, created_at
       FROM projects
       WHERE user_id = $1 AND archived = false
       ORDER BY created_at ASC`,
      [userId],
    );
    return { items: rows };
  });

  return app;
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
