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
  // M1 provider keys — both optional. Without OPENAI_API_KEY, transcription
  // returns 503 and clients degrade to typed input. Without ANTHROPIC_API_KEY,
  // intent parsing uses the deterministic heuristic parser only.
  OPENAI_API_KEY: z.string().min(10).optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_API_KEY: z.string().min(10).optional().or(z.literal("").transform(() => undefined)),
  // Override the intent-parsing model (default: claude-opus-4-8).
  NOVA_INTENT_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
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
