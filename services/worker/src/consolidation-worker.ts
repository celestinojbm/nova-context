import { Queue, Worker, type Job } from "bullmq";
import pg from "pg";
import { log } from "./log.js";
import type { WorkerEnv } from "./env.js";
import { revertConsolidationRun, runConsolidation, type ConsolidationMode } from "./memory/consolidate.js";

/** M20c: `memory-consolidation` queue. Mode comes from NOVA_CONSOLIDATION_MODE (default dry-run). */
export const CONSOLIDATION_QUEUE = "memory-consolidation";

export type ConsolidationJobData =
  | { kind?: "run"; userId?: string } // no userId = every user with active semantic facts
  | { kind: "revert"; runId: string };

export function startConsolidationWorker(env: WorkerEnv, pool?: pg.Pool): { worker: Worker<ConsolidationJobData>; close: () => Promise<void> } {
  const db = pool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const mode: ConsolidationMode = env.NOVA_CONSOLIDATION_MODE;
  const connection = { url: env.REDIS_URL };
  const worker = new Worker<ConsolidationJobData>(
    env.NOVA_CONSOLIDATION_QUEUE,
    async (job: Job<ConsolidationJobData>) => {
      const d = job.data;
      if (d.kind === "revert") return revertConsolidationRun(db, d.runId);
      const users = d.userId
        ? [d.userId]
        : (await db.query<{ user_id: string }>(
            `SELECT DISTINCT user_id FROM memory_items WHERE status = 'active' AND layer = 'semantic'`,
          )).rows.map((r) => r.user_id);
      const runs = [];
      for (const u of users) runs.push(await runConsolidation(db, u, mode));
      return { mode, runs: runs.length };
    },
    { connection, concurrency: 1 },
  );
  worker.on("completed", (job, res) => log.info({ job_id: job.id, result: res }, "memory consolidation done"));
  worker.on("failed", (job, err) => log.error({ job_id: job?.id, error_class: err.name }, "memory consolidation failed"));

  let queue: Queue | null = null;
  if (env.NOVA_CONSOLIDATION_CRON) {
    queue = new Queue(env.NOVA_CONSOLIDATION_QUEUE, { connection });
    void queue
      .upsertJobScheduler("nightly-consolidation", { pattern: env.NOVA_CONSOLIDATION_CRON }, { name: "run", data: {} })
      .catch((err) => log.error({ err }, "consolidation scheduler failed"));
  }
  return {
    worker,
    close: async () => {
      await worker.close();
      await queue?.close();
      if (!pool) await db.end();
    },
  };
}
