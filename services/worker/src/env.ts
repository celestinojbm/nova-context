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
