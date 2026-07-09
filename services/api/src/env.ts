import { z } from "zod";

// All runtime config through env vars, validated at boot (REPO_STRUCTURE §4.6).
// A missing or malformed variable crashes startup with a named error.
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://nova:nova@localhost:5432/nova"),
  PORT: z.coerce.number().int().positive().default(3001),
  // Optional single shared token for M0. OAuth 2.1 + PKCE + scopes is
  // deliberately NOT built yet (BUILD_PLAN §14: no public API).
  NOVA_API_TOKEN: z.string().min(16).optional().or(z.literal("").transform(() => undefined)),
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
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
