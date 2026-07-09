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
  if (signupMode === "invite" && !parsed.data.NOVA_ALPHA_INVITE_CODE && !isProduction) {
    // In dev, invite mode without a code is a config mistake worth naming.
    // In production it fails closed instead (no code ever matches).
    throw new Error(
      "Invalid environment configuration: NOVA_SIGNUP=invite requires NOVA_ALPHA_INVITE_CODE",
    );
  }
  return { ...parsed.data, isProduction, signupMode };
}
