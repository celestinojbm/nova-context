import { z } from "zod";

// All runtime config through env vars, validated at boot (REPO_STRUCTURE §4.6).
// A missing or malformed variable crashes startup with a named error.
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://nova:nova@localhost:5432/nova"),
  PORT: z.coerce.number().int().positive().default(3001),
  // M5: 'production' turns on strict behavior (signup defaults to invite-only
  // unless NOVA_SIGNUP says otherwise). Anything else is development.
  NODE_ENV: z.string().optional(),
  // M5 signup policy. 'open' = anyone can sign up (local dev default);
  // 'invite' = signup requires NOVA_ALPHA_INVITE_CODE (private alpha);
  // 'closed' = no signup endpoint at all. Defaults: open in dev, invite in
  // production (fail closed — a prod deploy without config takes no signups
  // because no invite code matches).
  NOVA_SIGNUP: z.enum(["open", "invite", "closed"]).optional(),
  NOVA_ALPHA_INVITE_CODE: z.string().min(8).optional().or(z.literal("").transform(() => undefined)),
  // Session lifetimes (fixed expiry; last_used_at is tracked for the UI).
  NOVA_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  NOVA_EXTENSION_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 30),
  // Optional. Used for voice transcription (Whisper) and query-time
  // embeddings for vector search. Without it: transcription returns 503
  // (clients degrade to typed input) and search runs keyword-only.
  // LLM enrichment keys (ANTHROPIC_API_KEY) belong to services/worker now —
  // the API never calls an LLM on the capture path.
  OPENAI_API_KEY: z.string().min(10).optional().or(z.literal("").transform(() => undefined)),
  // M2: Redis connection for the enrichment queue. Optional for the API —
  // without it, captures are stored with enrichment_status 'skipped'.
  REDIS_URL: z.string().optional().or(z.literal("").transform(() => undefined)),
  // Queue name override (mainly for test isolation).
  NOVA_ENRICHMENT_QUEUE: z.string().default("moment-enrichment"),
  // M6: approved external actions execute via this queue in services/worker.
  NOVA_ACTION_QUEUE: z.string().default("action-execution"),
  // M6: AES-256-GCM key for integration tokens at rest (32 bytes as hex or
  // base64; generate with `openssl rand -hex 32`). Without it, integration
  // connect/execute fails closed — and in production, configuring Notion
  // without it refuses to boot.
  NOVA_ENCRYPTION_KEY: z.string().min(32).optional().or(z.literal("").transform(() => undefined)),
  // M6: Notion OAuth app (per-user connections). All three required to
  // enable the connect flow; endpoints return 503 otherwise.
  NOTION_CLIENT_ID: z.string().min(8).optional().or(z.literal("").transform(() => undefined)),
  NOTION_CLIENT_SECRET: z.string().min(8).optional().or(z.literal("").transform(() => undefined)),
  NOTION_REDIRECT_URI: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  // M3: capture-time redaction of obvious sensitive data (emails, phones,
  // cards, keys, SSNs) BEFORE storage/enrichment/audit. Default on.
  NOVA_REDACTION: z.enum(["on", "off"]).default("on"),
  // M7: OCR-box masking of screenshots/frames BEFORE storage, live Q&A,
  // export, or adapter use. Default on (Tesseract, on-process).
  NOVA_IMAGE_REDACTION: z.enum(["on", "off"]).default("on"),
  // M7: server-side screenshot kill switch — 'off' strips every image
  // payload before storage regardless of client settings.
  NOVA_SCREENSHOT_STORAGE: z.enum(["on", "off"]).default("on"),
  // M7: Tesseract language-data location (vendor for air-gapped deploys);
  // unset = tesseract.js default CDN. Per-image OCR time budget.
  NOVA_OCR_LANG_PATH: z.string().optional().or(z.literal("").transform(() => undefined)),
  NOVA_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // M8: media pipeline object storage. 'fs' (default) writes encrypted
  // blobs under NOVA_MEDIA_FS_ROOT; 's3' targets any S3-compatible API
  // (MinIO locally, S3/R2 in production).
  NOVA_MEDIA_STORE: z.enum(["fs", "s3"]).default("fs"),
  NOVA_MEDIA_FS_ROOT: z.string().default("./var/media"),
  NOVA_MEDIA_S3_BUCKET: z.string().optional().or(z.literal("").transform(() => undefined)),
  NOVA_MEDIA_S3_REGION: z.string().default("us-east-1"),
  NOVA_MEDIA_S3_ENDPOINT: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  NOVA_MEDIA_S3_ACCESS_KEY_ID: z.string().optional().or(z.literal("").transform(() => undefined)),
  NOVA_MEDIA_S3_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  // M7: credential-surface rate limit (attempts per 15-minute window per IP)
  // and the Redis key namespace (override mainly for test isolation).
  NOVA_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  NOVA_RATE_LIMIT_PREFIX: z.string().default("nova:ratelimit"),
  // M3: live Q&A. The ONLY place the API sends captured content to a cloud
  // model, and only when explicitly enabled: 'auto' = on iff key present,
  // 'off' = never (endpoint returns 503).
  ANTHROPIC_API_KEY: z.string().min(10).optional().or(z.literal("").transform(() => undefined)),
  NOVA_LIVE_QA: z.enum(["auto", "off"]).default("auto"),
  NOVA_LIVE_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  // M4: funnel analytics. 'local' stores allowlisted product events in
  // Postgres (never captured content); 'off' drops them.
  NOVA_ANALYTICS: z.enum(["local", "off"]).default("local"),
});

export type Env = z.infer<typeof envSchema> & {
  isProduction: boolean;
  signupMode: "open" | "invite" | "closed";
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const isProduction = parsed.data.NODE_ENV === "production";
  const signupMode = parsed.data.NOVA_SIGNUP ?? (isProduction ? "invite" : "open");
  if (isProduction && parsed.data.NOTION_CLIENT_ID && !parsed.data.NOVA_ENCRYPTION_KEY) {
    // Fail closed at boot: a production Notion setup without an encryption
    // key would otherwise be one bug away from plaintext tokens.
    throw new Error(
      "Invalid environment configuration: NOTION_CLIENT_ID is set in production without NOVA_ENCRYPTION_KEY",
    );
  }
  if (isProduction && !parsed.data.NOVA_ENCRYPTION_KEY) {
    // M8: the media pipeline (and integrations) encrypt at rest with this
    // key. A production deploy without it would silently drop screenshots —
    // fail closed and loudly instead.
    throw new Error(
      "Invalid environment configuration: NOVA_ENCRYPTION_KEY is required in production (media + integration encryption at rest)",
    );
  }
  if (
    parsed.data.NOVA_MEDIA_STORE === "s3" &&
    (!parsed.data.NOVA_MEDIA_S3_BUCKET ||
      !parsed.data.NOVA_MEDIA_S3_ACCESS_KEY_ID ||
      !parsed.data.NOVA_MEDIA_S3_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      "Invalid environment configuration: NOVA_MEDIA_STORE=s3 requires NOVA_MEDIA_S3_BUCKET, NOVA_MEDIA_S3_ACCESS_KEY_ID, NOVA_MEDIA_S3_SECRET_ACCESS_KEY",
    );
  }
  if (
    isProduction &&
    parsed.data.NOTION_REDIRECT_URI &&
    !parsed.data.NOTION_REDIRECT_URI.startsWith("https://")
  ) {
    // OAuth codes must never transit plaintext HTTP in production.
    throw new Error(
      "Invalid environment configuration: NOTION_REDIRECT_URI must be https:// in production",
    );
  }
  if (signupMode === "invite" && !parsed.data.NOVA_ALPHA_INVITE_CODE && !isProduction) {
    // In dev, invite mode without a code is a config mistake worth naming.
    // In production it fails closed instead (no code ever matches).
    throw new Error(
      "Invalid environment configuration: NOVA_SIGNUP=invite requires NOVA_ALPHA_INVITE_CODE",
    );
  }
  return { ...parsed.data, isProduction, signupMode };
}

/** One-line security posture, logged at boot so a misconfigured production
 * deploy is visible in the first screen of logs. */
export function securitySummary(env: Env): string {
  return [
    `mode=${env.isProduction ? "production" : "development"}`,
    `signup=${env.signupMode}`,
    `redaction=${env.NOVA_REDACTION}`,
    `image_redaction=${env.NOVA_IMAGE_REDACTION}`,
    `screenshot_storage=${env.NOVA_SCREENSHOT_STORAGE}`,
    `token_encryption=${env.NOVA_ENCRYPTION_KEY ? "on" : "OFF"}`,
    `media=${env.NOVA_ENCRYPTION_KEY ? env.NOVA_MEDIA_STORE : "UNAVAILABLE (no key)"}`,
    `rate_limit=${env.REDIS_URL ? "redis" : "in-memory"}`,
    `notion=${env.NOTION_CLIENT_ID ? "configured" : "off"}`,
    `live_qa=${env.NOVA_LIVE_QA}`,
    `analytics=${env.NOVA_ANALYTICS}`,
  ].join(" ");
}
