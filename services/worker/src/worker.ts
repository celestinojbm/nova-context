import { Worker, type Job } from "bullmq";
import pg from "pg";
import {
  AnthropicEnricher,
  OpenAIEmbedder,
  type EmbeddingProvider,
} from "@nova/model-router";
import { enrichMoment, markFailed, type EnrichDeps } from "./enrich.js";
import type { WorkerEnv } from "./env.js";

/** Mirrors services/api/src/queue.ts — the producer side of this contract. */
export const ENRICHMENT_QUEUE = "moment-enrichment";

export interface EnrichmentJobData {
  momentId: string;
  userId: string;
}

export function buildDeps(env: WorkerEnv): EnrichDeps {
  const cloudEnabled =
    env.NOVA_CLOUD_ENRICHMENT === "auto" && Boolean(env.ANTHROPIC_API_KEY);
  const enricher = cloudEnabled
    ? new AnthropicEnricher({
        apiKey: env.ANTHROPIC_API_KEY!,
        model: env.NOVA_ENRICH_MODEL,
      })
    : null;
  const embedder: EmbeddingProvider | null = env.OPENAI_API_KEY
    ? new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY })
    : null;
  return { enricher, embedder, analytics: env.NOVA_ANALYTICS };
}

export interface StartWorkerOptions {
  env: WorkerEnv;
  pool?: pg.Pool;
  deps?: EnrichDeps;
  concurrency?: number;
  queueName?: string;
}

export function startWorker({
  env,
  pool,
  deps,
  concurrency = 2,
  queueName,
}: StartWorkerOptions): Worker<EnrichmentJobData> {
  const db = pool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const resolvedDeps = deps ?? buildDeps(env);

  const worker = new Worker<EnrichmentJobData>(
    queueName ?? env.NOVA_ENRICHMENT_QUEUE,
    async (job: Job<EnrichmentJobData>) => {
      await enrichMoment(db, resolvedDeps, job.data.momentId);
    },
    { connection: { url: env.REDIS_URL }, concurrency },
  );

  worker.on("failed", (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    const madeAll = (job?.attemptsMade ?? 0) >= attempts;
    console.error(
      `[worker] enrich ${job?.data.momentId} attempt ${job?.attemptsMade}/${attempts} failed: ${err.message}`,
    );
    // Mark failed only after the FINAL attempt; earlier failures retry and
    // the moment stays 'processing'.
    if (job && madeAll) {
      void markFailed(db, job.data.momentId, job.data.userId, err.message).catch(
        (markErr) => console.error("[worker] markFailed errored:", markErr),
      );
    }
  });
  worker.on("completed", (job) => {
    console.log(`[worker] enriched moment ${job.data.momentId}`);
  });

  if (!pool) {
    worker.on("closed", () => {
      void db.end();
    });
  }
  return worker;
}
