import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  AnthropicLiveQa,
  IntentRouter,
  OpenAIEmbedder,
  OpenAITranscriber,
  TranscriptionRouter,
  type EmbeddingProvider,
  type LiveQaProvider,
} from "@nova/model-router";
import {
  createContextMomentRequestSchema,
  type ContextMoment,
  type CreateContextMomentResponse,
  type EnrichmentResult,
  type ListContextMomentsResponse,
  type ParsedIntent,
} from "@nova/schema";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import type { Env } from "./env.js";
import { Analytics } from "./analytics.js";
import { createEnrichmentQueue, type EnrichmentJob } from "./queue.js";
import { registerAuth, requireAuth } from "./auth/plugin.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerM1Routes } from "./routes-m1.js";
import { registerM2Routes } from "./routes-m2.js";
import { registerM3Routes } from "./routes-m3.js";
import { registerM4Routes } from "./routes-m4.js";
import { redactDeep, suggestProjects, type RedactionType } from "@nova/context-engine";

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
  intent_parsed: ParsedIntent | null;
  enrichment_status: "pending" | "processing" | "completed" | "failed" | "skipped";
  enrichment: EnrichmentResult | null;
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
    intent_parsed: row.intent_parsed,
    enrichment_status: row.enrichment_status,
    enrichment: row.enrichment,
  };
}

const MOMENT_COLUMN_NAMES = [
  "id",
  "project_id",
  "source_mode",
  "source_meta",
  "payload",
  "extracted_text",
  "intent_text",
  "summary",
  "captured_at",
  "redaction_state",
  "intent_parsed",
  "enrichment_status",
  "enrichment",
];
const MOMENT_COLUMNS = MOMENT_COLUMN_NAMES.join(", ");
const MOMENT_COLUMNS_PREFIXED = MOMENT_COLUMN_NAMES.map((c) => `m.${c}`).join(", ");

/** Intent action types that auto-execute a Tier-0 Nova task. A reminder is a
 * task with a follow-up flavor in M1; scheduling arrives with calendar
 * integration (M2+, per docs/ACTION_ENGINE.md). */
const TASK_CREATING_ACTIONS = new Set(["create_task", "remind_follow_up"]);

export interface BuildAppOptions {
  env: Env;
  pool?: pg.Pool;
  /** Test override for the live Q&A provider (bypasses env wiring). */
  liveQa?: LiveQaProvider | null;
}

export async function buildApp({ env, pool, liveQa }: BuildAppOptions): Promise<FastifyInstance> {
  const db = pool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const app = Fastify({
    logger: true,
    // Screenshot data URLs ride in the JSON body; default 1MB is too small.
    bodyLimit: 4 * 1024 * 1024,
  });

  // The extension (chrome-extension:// origin) and the web app both call the
  // API cross-origin in dev. M0 is single-user local; tighten with real auth.
  await app.register(cors, { origin: true });
  // Voice uploads (POST /v1/transcriptions). Push-to-talk clips are short;
  // 15MB comfortably covers minutes of webm/opus.
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });

  // M2: the capture path stays fast — the API runs ONLY the local heuristic
  // intent parser synchronously; LLM refinement happens in services/worker.
  const intentRouter = new IntentRouter([]);
  const transcriptionRouter = new TranscriptionRouter(
    env.OPENAI_API_KEY
      ? [new OpenAITranscriber({ apiKey: env.OPENAI_API_KEY })]
      : [],
  );
  // Query-time embeddings for the vector search leg (optional).
  const embedder: EmbeddingProvider | null = env.OPENAI_API_KEY
    ? new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY })
    : null;
  // Live Q&A (M3): explicit config gate — the only API path that sends
  // captured content to a cloud model (docs/SECURITY_PRIVACY_GOVERNANCE.md).
  const liveQaProvider: LiveQaProvider | null =
    liveQa !== undefined
      ? liveQa
      : env.NOVA_LIVE_QA === "auto" && env.ANTHROPIC_API_KEY
        ? new AnthropicLiveQa({ apiKey: env.ANTHROPIC_API_KEY, model: env.NOVA_LIVE_MODEL })
        : null;
  const redactionOn = env.NOVA_REDACTION === "on";
  // M4: privacy-preserving funnel analytics (allowlisted events, no content).
  const analytics = new Analytics(db, env.NOVA_ANALYTICS === "local");

  // Enrichment queue producer (optional): without Redis, moments store with
  // enrichment_status 'skipped' and everything else keeps working.
  const enrichmentQueue = env.REDIS_URL
    ? createEnrichmentQueue(env.REDIS_URL, env.NOVA_ENRICHMENT_QUEUE)
    : null;
  if (enrichmentQueue) {
    app.addHook("onClose", async () => {
      await enrichmentQueue.close();
    });
  }

  if (!pool) {
    app.addHook("onClose", async () => {
      await db.end();
    });
  }

  // M5: every /v1 route runs behind the session middleware (fail closed);
  // the auth routes themselves carry the small public allowlist.
  registerAuth(app, db);
  registerAuthRoutes(app, { db, env });

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
    const userId = requireAuth(req).userId;

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

    // M3: capture-time redaction BEFORE anything else touches the content —
    // intent parsing, suggestions, storage, enrichment, and audit all see
    // only the redacted form. Screenshots (data: URLs) pass through; visual
    // redaction is a documented v0 gap.
    let redactionTally: Map<RedactionType, number> | null = null;
    if (redactionOn) {
      redactionTally = new Map();
      body.extracted_text = body.extracted_text
        ? redactDeep(body.extracted_text, redactionTally)
        : body.extracted_text;
      body.intent_text = body.intent_text
        ? redactDeep(body.intent_text, redactionTally)
        : body.intent_text;
      body.payload = redactDeep(body.payload, redactionTally);
      if (body.source_meta.title) {
        body.source_meta.title = redactDeep(body.source_meta.title, redactionTally);
      }
    }

    // Synchronous parse is heuristic-only (local, sub-millisecond); the
    // worker refines it with an LLM asynchronously when configured.
    let intent: ParsedIntent | null = null;
    if (body.intent_text?.trim()) {
      const projectNames = (
        await db.query<{ name: string }>(
          "SELECT name FROM projects WHERE user_id = $1 AND archived = false",
          [userId],
        )
      ).rows.map((r) => r.name);
      const parseResult = await intentRouter.parse({
        text: body.intent_text,
        pageTitle: (body.source_meta["title"] as string | undefined) ?? null,
        knownProjects: projectNames,
      });
      intent = parseResult.intent;
      for (const failure of parseResult.failures) {
        req.log.warn({ failure }, "intent provider failed; fell back");
      }
    }

    // Rule-based project suggestions — the same scoring the UI previewed.
    const suggestions = await suggestProjects(db, userId, {
      projectHint: intent?.project_hint ?? null,
      url: (body.source_meta["url"] as string | undefined) ?? null,
    });

    const { rows } = await db.query<MomentRow>(
      `INSERT INTO context_moments
         (user_id, project_id, source_mode, source_meta, payload, extracted_text, intent_text, intent_parsed, enrichment_status, redaction_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${MOMENT_COLUMNS}`,
      [
        userId,
        body.project_id ?? null,
        body.source_mode,
        JSON.stringify(body.source_meta),
        JSON.stringify(body.payload),
        body.extracted_text ?? null,
        body.intent_text ?? null,
        intent ? JSON.stringify(intent) : null,
        enrichmentQueue ? "pending" : "skipped",
        redactionOn ? "applied" : "skipped",
      ],
    );
    const moment = rowToMoment(rows[0]!);

    // Enqueue async enrichment. A queue failure must never fail the capture:
    // downgrade the moment to 'skipped' and move on.
    let enrichmentJobId: string | null = null;
    if (enrichmentQueue) {
      try {
        const job = await enrichmentQueue.add("enrich", {
          momentId: moment.id,
          userId,
        } satisfies EnrichmentJob);
        enrichmentJobId = job.id ?? null;
      } catch (err) {
        req.log.warn({ err }, "enrichment enqueue failed; marking skipped");
        await db.query(
          "UPDATE context_moments SET enrichment_status = 'skipped' WHERE id = $1",
          [moment.id],
        );
        moment.enrichment_status = "skipped";
      }
    }

    // Override logging (BUILD_PLAN §12): the user linked a project different
    // from the top suggestion — retained as a training signal.
    const topSuggestion = suggestions[0];
    if (body.project_id && topSuggestion && topSuggestion.id !== body.project_id) {
      await db.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'project.link.override', 'moment', $2, $3)`,
        [
          userId,
          moment.id,
          JSON.stringify({
            chosen_project_id: body.project_id,
            suggested_project_id: topSuggestion.id,
            suggested_confidence: topSuggestion.confidence,
          }),
        ],
      );
    }

    // Tier-0 action (docs/ACTION_ENGINE.md): internal + reversible, so it
    // auto-executes — a task in Nova's own list, linked to the moment.
    // External targets (Notion etc.) are Tier-1 and arrive in M2.
    let task: { id: string; title: string } | null = null;
    if (intent && TASK_CREATING_ACTIONS.has(intent.action_type)) {
      const actionRow = await db.query<{ id: string }>(
        `INSERT INTO actions (user_id, moment_id, project_id, action_type, risk_tier, status, payload)
         VALUES ($1, $2, $3, 'nova_task', 0, 'done', $4)
         RETURNING id`,
        [
          userId,
          moment.id,
          moment.project_id,
          JSON.stringify({ title: intent.summary, priority: intent.priority_guess }),
        ],
      );
      const actionId = actionRow.rows[0]!.id;
      const taskRow = await db.query<{ id: string; title: string }>(
        `INSERT INTO tasks (user_id, project_id, moment_id, action_id, title, notes, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, title`,
        [
          userId,
          moment.project_id,
          moment.id,
          actionId,
          intent.summary,
          body.intent_text ?? null,
          intent.priority_guess,
        ],
      );
      task = taskRow.rows[0]!;
      await db.query(
        `UPDATE actions SET result = $1, updated_at = now() WHERE id = $2`,
        [JSON.stringify({ task_id: task.id }), actionId],
      );
      await db.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'action.execute', 'action', $2, $3)`,
        [
          userId,
          actionId,
          JSON.stringify({
            action_type: "nova_task",
            risk_tier: 0,
            task_id: task.id,
            intent_parser: intent.parser,
          }),
        ],
      );
    }

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
          intent_action: intent?.action_type ?? null,
          intent_parser: intent?.parser ?? null,
          redactions: redactionTally
            ? Object.fromEntries(redactionTally)
            : null,
        }),
      ],
    );

    analytics.track(
      userId,
      moment.source_mode === "live_context" ? "live_moment_saved" : "instant_capture_saved",
      {
        has_screenshot: typeof body.payload["screenshot_data_url"] === "string",
        has_intent: Boolean(body.intent_text),
        linked: Boolean(moment.project_id),
        enrichment: enrichmentJobId ? "queued" : "skipped",
        redactions: redactionTally
          ? [...redactionTally.values()].reduce((a, b) => a + b, 0)
          : 0,
      },
    );

    const response: CreateContextMomentResponse = {
      id: moment.id,
      project_id: moment.project_id,
      summary: null,
      captured_at: moment.captured_at,
      redaction_state: moment.redaction_state,
      enrichment: enrichmentJobId
        ? { status: "queued", job_id: enrichmentJobId }
        : { status: "skipped", job_id: null },
      suggested_projects: moment.project_id ? [] : suggestions,
      links: { self: `/v1/context/moments/${moment.id}` },
      intent,
      task,
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
    const userId = requireAuth(req).userId;

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
      `SELECT ${MOMENT_COLUMNS}
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
    const userId = requireAuth(req).userId;
    const { rows } = await db.query<MomentRow>(
      `SELECT ${MOMENT_COLUMNS}
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

  app.get("/v1/projects", async (req) => {
    const userId = requireAuth(req).userId;
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.description, p.created_at,
              count(DISTINCT m.id)::int AS moment_count,
              count(DISTINCT t.id)::int AS task_count
       FROM projects p
       LEFT JOIN context_moments m ON m.project_id = p.id
       LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.user_id = $1 AND p.archived = false
       GROUP BY p.id
       ORDER BY p.created_at ASC`,
      [userId],
    );
    return { items: rows };
  });

  registerM1Routes(app, { db, intentRouter, transcriptionRouter, analytics });
  registerM2Routes(app, {
    db,
    embedder,
    momentColumns: MOMENT_COLUMNS,
    momentColumnsPrefixed: MOMENT_COLUMNS_PREFIXED,
    rowToMoment: rowToMoment as (row: never) => ContextMoment,
    analytics,
  });
  registerM3Routes(app, {
    db,
    liveQa: liveQaProvider,
    redactionOn,
    momentColumns: MOMENT_COLUMNS,
    rowToMoment: rowToMoment as (row: never) => ContextMoment,
    analytics,
  });
  registerM4Routes(app, { db, analytics });

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
