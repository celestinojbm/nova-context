import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://nova:nova@localhost:5432/nova"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ANTHROPIC_API_KEY: z.string().min(10).optional().or(z.literal("").transform(() => undefined)),
  OPENAI_API_KEY: z.string().min(10).optional().or(z.literal("").transform(() => undefined)),
  // Explicit control over sending captured content to a cloud model:
  // 'auto' = only when a key is configured; 'off' = never.
  NOVA_CLOUD_ENRICHMENT: z.enum(["auto", "off"]).default("auto"),
  NOVA_ENRICH_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  NOVA_ENRICHMENT_QUEUE: z.string().default("moment-enrichment"),
  // M4: same semantics as the API — 'local' stores product events, 'off' drops.
  NOVA_ANALYTICS: z.enum(["local", "off"]).default("local"),
  // M6: action-execution queue (approved external actions from the API).
  NOVA_ACTION_QUEUE: z.string().default("action-execution"),
  // M6: key for decrypting integration tokens (same value as the API's).
  // Without it, external actions fail closed with 'encryption_key_missing'.
  NOVA_ENCRYPTION_KEY: z.string().min(32).optional().or(z.literal("").transform(() => undefined)),
  // M11: previous keys still valid for READS during gradual rotation
  // (comma-separated; same value as the API's).
  NOVA_ENCRYPTION_KEYS_PREVIOUS: z.string().optional().or(z.literal("").transform(() => undefined)),
  // M10: media pipeline access for explicitly-approved Notion media
  // uploads. Same values as the API — the worker reads (never writes)
  // encrypted blobs through the shared object-store abstraction.
  NOVA_MEDIA_STORE: z.enum(["fs", "s3"]).default("fs"),
  NOVA_MEDIA_FS_ROOT: z.string().default("./var/media"),
  NOVA_MEDIA_S3_BUCKET: z.string().optional().or(z.literal("").transform(() => undefined)),
  NOVA_MEDIA_S3_REGION: z.string().default("us-east-1"),
  NOVA_MEDIA_S3_ENDPOINT: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  NOVA_MEDIA_S3_ACCESS_KEY_ID: z.string().optional().or(z.literal("").transform(() => undefined)),
  NOVA_MEDIA_S3_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid worker environment: ${issues}`);
  }
  return parsed.data;
}
