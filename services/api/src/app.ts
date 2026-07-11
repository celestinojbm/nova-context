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
  type ContextMomentWithMedia,
  type EnrichmentMeta,
  type MomentMediaRef,
  type CreateContextMomentResponse,
  type EnrichmentResult,
  type ListContextMomentsResponse,
  type ParsedIntent,
} from "@nova/schema";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import pg from "pg";
import { z } from "zod";
import type { Env } from "./env.js";
import { Analytics } from "./analytics.js";
import { createActionQueue, createEnrichmentQueue, type EnrichmentJob } from "./queue.js";
import { registerAuth, requireAuth } from "./auth/plugin.js";
import { createRateLimiter } from "./auth/rate-limit.js";
import { extractPayloadImages, redactPayloadImages } from "./image-redaction.js";
import { sanitizeLegacyInlineMedia } from "./legacy-media.js";
import { MediaService } from "./media/media-service.js";
import { storeFromEnv, type ObjectStore } from "./media/object-store.js";
import { registerAccountRoutes } from "./routes-account.js";
import { registerFeedbackRoutes } from "./routes-feedback.js";
import { registerOpsRoutes } from "./routes-ops.js";
import { registerMediaRoutes } from "./routes-media.js";
import { TesseractOcrEngine } from "./ocr.js";
import { HttpNotionApiClient, type NotionApiClient } from "./integrations/notion-api.js";
import { HttpNotionOAuthClient, type NotionOAuthClient } from "./integrations/notion-oauth.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerIntegrationRoutes } from "./routes-integrations.js";
import { registerM1Routes } from "./routes-m1.js";
import { registerM2Routes } from "./routes-m2.js";
import { registerM3Routes } from "./routes-m3.js";
import { registerM4Routes } from "./routes-m4.js";
import { redactDeep, suggestProjects, type RedactionType } from "@nova/context-engine";
import { parseEncryptionKey, parseKeyList } from "@nova/context-engine/secret-box";
import type { OcrEngine } from "@nova/context-engine/visual-redaction";

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
  image_redaction: Record<string, unknown>;
}

function rowToMoment(row: MomentRow): ContextMoment {
  return {
    id: row.id,
    project_id: row.project_id,
    source_mode: row.source_mode,
    source_meta: row.source_meta,
    // M15B (Hermes D01): strip any LEGACY inline media that never passed the
    // media redaction gates. This is THE chokepoint — every payload-returning
    // path (single/list/search/project/legacy export/account export) maps
    // rows through here, so none of them can leak inline `data:image` bytes.
    payload: sanitizeLegacyInlineMedia(row.payload) as ContextMoment["payload"],
    extracted_text: row.extracted_text,
    intent_text: row.intent_text,
    summary: row.summary,
    captured_at: row.captured_at.toISOString(),
    redaction_state: row.redaction_state,
    intent_parsed: row.intent_parsed,
    enrichment_status: row.enrichment_status,
    enrichment: row.enrichment,
    image_redaction: row.image_redaction as ContextMoment["image_redaction"],
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
  "image_redaction",
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
  /** Test override for the Notion OAuth client (bypasses env wiring). */
  notionOauth?: NotionOAuthClient | null;
  /** Test override for the OCR engine (bypasses env wiring). */
  ocr?: OcrEngine | null;
  /** Test override for the read-only Notion API client (M7 destinations). */
  notionApi?: NotionApiClient | null;
  /** Test override for the media object store (M8). */
  objectStore?: ObjectStore;
  /** M11: test hook — pipe structured logs to a stream for hygiene checks. */
  loggerStream?: { write: (msg: string) => void };
}

export async function buildApp({
  env,
  pool,
  liveQa,
  notionOauth,
  ocr,
  notionApi,
  objectStore,
  loggerStream,
}: BuildAppOptions): Promise<FastifyInstance> {
  const db = pool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const app = Fastify({
    logger: loggerStream ? { stream: loggerStream } : true,
    // M11 observability: honor an incoming x-request-id (proxy/web app
    // correlation) or mint one; every response carries it back.
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w.-]{1,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
    // Screenshot data URLs ride in the JSON body; default 1MB is too small.
    bodyLimit: 4 * 1024 * 1024,
    // M13 guardrail: no request may hang forever (OCR + live Q&A budgets
    // fit comfortably; a wedged upstream fails loudly instead of piling up).
    requestTimeout: env.NOVA_REQUEST_TIMEOUT_MS,
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
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
  // M7: on-process OCR for visual redaction (never a cloud call). null =
  // image redaction off; captures then store with state 'skipped'.
  const ocrEngine: OcrEngine | null =
    ocr !== undefined
      ? ocr
      : env.NOVA_IMAGE_REDACTION === "on"
        ? new TesseractOcrEngine({
            langPath: env.NOVA_OCR_LANG_PATH,
            timeoutMs: env.NOVA_OCR_TIMEOUT_MS,
          })
        : null;
  if (ocrEngine instanceof TesseractOcrEngine) {
    app.addHook("onClose", async () => {
      await ocrEngine.close();
    });
  }
  const screenshotStorageOn = env.NOVA_SCREENSHOT_STORAGE === "on";
  // M8: media pipeline — encrypted blobs in object storage, metadata in
  // moment_media. Without the encryption key the pipeline is UNAVAILABLE
  // and captures strip images (state 'media_unavailable') rather than
  // storing pixels outside it. Production refuses to boot without the key.
  const mediaKey = env.NOVA_ENCRYPTION_KEY ? parseEncryptionKey(env.NOVA_ENCRYPTION_KEY) : null;
  // M11 multi-key read: current key first (all writes), then previous keys
  // that may still open old blobs during a gradual rotation.
  const mediaKeys = mediaKey
    ? [mediaKey, ...(env.NOVA_ENCRYPTION_KEYS_PREVIOUS ? parseKeyList(env.NOVA_ENCRYPTION_KEYS_PREVIOUS) : [])]
    : null;
  const mediaStore: ObjectStore = objectStore ?? storeFromEnv(env);
  const media = mediaKeys ? new MediaService(db, mediaStore, mediaKeys) : null;
  /** Attach media refs to a batch of API-shaped moments (single query). */
  async function attachMedia<T extends { id: string }>(
    items: T[],
  ): Promise<Array<T & { media: MomentMediaRef[] }>> {
    const map = media ? await media.listForMoments(items.map((m) => m.id)) : new Map();
    return items.map((m) => ({ ...m, media: map.get(m.id) ?? [] }));
  }

  /** M11: enrichment version metadata for the timeline (single query) —
   * latest provider/model/version + how many prior versions exist. */
  async function attachEnrichmentMeta<T extends { id: string }>(
    items: T[],
  ): Promise<Array<T & { enrichment_meta: EnrichmentMeta | null }>> {
    if (!items.length) return items.map((m) => ({ ...m, enrichment_meta: null }));
    const { rows } = await db.query<{
      moment_id: string;
      version: number;
      provider: string | null;
      model: string | null;
      created_at: Date;
      total: string;
    }>(
      `SELECT DISTINCT ON (moment_id)
              moment_id, version, provider, model, created_at,
              count(*) OVER (PARTITION BY moment_id) AS total
       FROM enrichment_versions WHERE moment_id = ANY($1::uuid[])
       ORDER BY moment_id, version DESC`,
      [items.map((m) => m.id)],
    );
    const map = new Map(
      rows.map((r) => [
        r.moment_id,
        {
          latest_version: r.version,
          versions: Number(r.total),
          provider: r.provider,
          model: r.model,
          created_at: r.created_at.toISOString(),
        },
      ]),
    );
    return items.map((m) => ({ ...m, enrichment_meta: map.get(m.id) ?? null }));
  }
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
  // M6: approved external actions execute via this queue in services/worker.
  // Without Redis, approving an external action returns 503 (fail closed).
  const actionQueue = env.REDIS_URL
    ? createActionQueue(env.REDIS_URL, env.NOVA_ACTION_QUEUE)
    : null;
  if (actionQueue) {
    app.addHook("onClose", async () => {
      await actionQueue.close();
    });
  }
  // M6: Notion OAuth — enabled only when the app is registered AND the
  // token-encryption key exists; otherwise the routes answer 503.
  const notionOauthClient: NotionOAuthClient | null =
    notionOauth !== undefined
      ? notionOauth
      : env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET && env.NOTION_REDIRECT_URI
        ? new HttpNotionOAuthClient({
            clientId: env.NOTION_CLIENT_ID,
            clientSecret: env.NOTION_CLIENT_SECRET,
            redirectUri: env.NOTION_REDIRECT_URI,
          })
        : null;

  if (!pool) {
    app.addHook("onClose", async () => {
      await db.end();
    });
  }

  // M5: every /v1 route runs behind the session middleware (fail closed);
  // the auth routes themselves carry the small public allowlist.
  registerAuth(app, db);
  // M7: credential-surface rate limiting — Redis-shared across instances
  // when REDIS_URL is set, in-memory otherwise.
  const rateLimiter = createRateLimiter(env.REDIS_URL, {
    windowMs: 15 * 60 * 1000,
    max: env.NOVA_RATE_LIMIT_MAX,
    prefix: env.NOVA_RATE_LIMIT_PREFIX,
    // M15 (Hermes P2): a Redis outage falls back to a fail-closed in-memory
    // window and logs a structured security warning (event name + class
    // only, never secrets/content).
    warn: (event, detail) => app.log.warn(detail, event),
  });
  app.addHook("onClose", async () => {
    await rateLimiter.close();
  });
  registerAuthRoutes(app, { db, env, rateLimiter });
  const notionApiClient: NotionApiClient | null =
    notionApi !== undefined ? notionApi : notionOauthClient ? new HttpNotionApiClient() : null;
  registerIntegrationRoutes(app, {
    db,
    env,
    notionOauth: notionOauthClient,
    notionApi: notionApiClient,
  });
  registerMediaRoutes(app, { db, media, viewAudit: env.NOVA_MEDIA_VIEW_AUDIT === "on" });
  // M11 ops surface: /readyz (public readiness) + /v1/ops/status (authed).
  const opsRedis = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 }) : null;
  if (opsRedis) {
    app.addHook("onClose", async () => {
      opsRedis.disconnect();
    });
  }
  registerOpsRoutes(app, {
    db,
    env,
    redis: opsRedis,
    enrichmentQueue: enrichmentQueue as never,
    actionQueue: actionQueue as never,
    store: mediaStore,
    mediaAvailable: media !== null,
    rateLimiter,
  });
  registerAccountRoutes(app, {
    db,
    media,
    analytics,
    momentColumns: MOMENT_COLUMNS,
    rowToMoment: rowToMoment as (row: never) => ContextMoment,
    rateLimiter,
  });
  // M13: private-alpha feedback intake.
  registerFeedbackRoutes(app, { db, analytics, rateLimiter });

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

    // M7: visual redaction BEFORE storage — screenshots are OCR-box masked
    // (or stripped, per settings) so unredacted pixels never persist.
    // M15 (Hermes P1): in production, strict is FORCED on regardless of what
    // the client sent — an old or malicious client cannot request unsafe
    // retention. On OCR failure the image becomes 'blocked_strict' (dropped)
    // instead of 'failed' (kept). Belt to the storeMomentImages suspenders.
    const effectiveStrict = body.strict_image_redaction || env.isProduction;
    const imageOutcome = await redactPayloadImages(body.payload, {
      ocr: ocrEngine,
      strict: effectiveStrict,
      storageEnabled: screenshotStorageOn,
    });
    body.payload = imageOutcome.payload;
    const imageReport = imageOutcome.report;

    // M8: pixels leave the JSON payload here — redacted images go to the
    // media pipeline (encrypted object storage + moment_media). If the
    // pipeline is unavailable, images are DROPPED, never stored inline.
    const extraction = extractPayloadImages(body.payload);
    body.payload = extraction.payload;
    if (extraction.images.length && !media) {
      imageReport.state = "media_unavailable";
      extraction.images.length = 0;
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
         (user_id, project_id, source_mode, source_meta, payload, extracted_text, intent_text, intent_parsed, enrichment_status, redaction_state, image_redaction, ocr_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        JSON.stringify(imageReport),
        imageOutcome.ocrText,
      ],
    );
    const moment = rowToMoment(rows[0]!);

    // M8: persist redacted images through the pipeline and reference them.
    let momentMedia: MomentMediaRef[] = [];
    if (extraction.images.length && media) {
      try {
        momentMedia = await media.storeMomentImages(
          userId,
          moment.id,
          extraction.images,
          imageReport.state,
        );
      } catch (err) {
        // Media failure must not lose the capture; the moment stands, imageless.
        req.log.error({ err }, "media pipeline store failed");
      }
    }

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
      analytics.track(userId, "task_created", { tier: 0, priority: intent.priority_guess });
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
          text_redaction: redactionOn ? "applied" : "skipped",
          redactions: redactionTally
            ? Object.fromEntries(redactionTally)
            : null,
          image_redaction: imageReport.state,
          image_redactions: imageReport.tally,
          images_masked: imageReport.masked,
          image_storage_disabled: !screenshotStorageOn,
          strict_blocked: imageReport.state === "blocked_strict",
          media_stored: momentMedia.length,
        }),
      ],
    );

    analytics.track(
      userId,
      moment.source_mode === "live_context" ? "live_moment_saved" : "instant_capture_saved",
      {
        has_screenshot: typeof body.payload["screenshot_data_url"] === "string",
        image_redaction: imageReport.state,
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
      image_redaction: imageReport,
      media: momentMedia,
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
    const items = await attachEnrichmentMeta(await attachMedia(rows.map(rowToMoment)));
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
    const [withMedia] = await attachEnrichmentMeta(await attachMedia([rowToMoment(row)]));
    return withMedia;
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
    actionQueue,
    attachMedia,
  });
  registerM3Routes(app, {
    db,
    liveQa: liveQaProvider,
    redactionOn,
    ocr: ocrEngine,
    momentColumns: MOMENT_COLUMNS,
    rowToMoment: rowToMoment as (row: never) => ContextMoment,
    analytics,
    media,
  });
  registerM4Routes(app, { db, analytics, media });

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
