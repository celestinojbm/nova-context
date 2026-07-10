import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type pg from "pg";
import { pendingMigrations } from "./db/migrate.js";
import type { ObjectStore } from "./media/object-store.js";
import type { Env } from "./env.js";

/**
 * M11 operations surface.
 *
 *   GET /healthz  — liveness (process up, Postgres reachable). Public.
 *   GET /readyz   — readiness (DB + migrations + Redis when configured +
 *                   media store probe). Public booleans only, no data —
 *                   this is what a deploy gate / orchestrator polls.
 *   GET /v1/ops/status — the internal status page's data source. Requires
 *                   a session like every /v1 route. Counts and booleans
 *                   only: NO captured content, keys, or tokens.
 */

export const WORKER_HEARTBEAT_KEY = "nova:heartbeat:worker";
/** A worker heartbeat older than this is reported as stale. */
export const WORKER_HEARTBEAT_STALE_MS = 120_000;

export interface OpsDeps {
  db: pg.Pool;
  env: Env;
  redis: Redis | null;
  enrichmentQueue: Queue | null;
  actionQueue: Queue | null;
  store: ObjectStore;
  mediaAvailable: boolean;
}

async function check<T>(fn: () => Promise<T>): Promise<{ ok: boolean; error?: string; value?: T }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    // Component name + error class only — messages can carry hosts/paths,
    // never content, but keep them short anyway.
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

/** Write-read-delete probe: proves the object store accepts our traffic. */
export async function probeStore(store: ObjectStore): Promise<void> {
  const key = `__ops/probe-${Date.now()}`;
  const payload = Buffer.from("nova-ops-probe");
  await store.put(key, payload);
  const back = await store.get(key);
  await store.delete(key);
  if (!back || !back.equals(payload)) throw new Error("store probe read mismatch");
}

export async function readiness(deps: OpsDeps): Promise<{
  ready: boolean;
  checks: Record<string, { ok: boolean; error?: string; detail?: string }>;
}> {
  const checks: Record<string, { ok: boolean; error?: string; detail?: string }> = {};

  const db = await check(() => deps.db.query("SELECT 1"));
  checks.postgres = { ok: db.ok, ...(db.error ? { error: db.error } : {}) };

  const pending = await check(() => pendingMigrations(deps.db));
  checks.migrations = pending.ok
    ? pending.value!.length
      ? { ok: false, detail: `${pending.value!.length} pending` }
      : { ok: true }
    : { ok: false, error: pending.error };

  if (deps.redis) {
    const redis = await check(() => deps.redis!.ping());
    checks.redis = { ok: redis.ok, ...(redis.error ? { error: redis.error } : {}) };
  } else {
    checks.redis = { ok: true, detail: "not configured (enrichment/actions disabled)" };
  }

  if (deps.mediaAvailable) {
    const store = await check(() => probeStore(deps.store));
    checks.media_store = { ok: store.ok, ...(store.error ? { error: store.error } : {}) };
  } else {
    checks.media_store = { ok: true, detail: "media pipeline disabled (no encryption key)" };
  }

  return { ready: Object.values(checks).every((c) => c.ok), checks };
}

export async function opsStatus(deps: OpsDeps): Promise<Record<string, unknown>> {
  const { db, redis, enrichmentQueue, actionQueue } = deps;
  const ready = await readiness(deps);

  // Worker heartbeat (set by services/worker every 30s with a TTL).
  let worker: { ok: boolean; last_beat: string | null; detail?: string } = {
    ok: false,
    last_beat: null,
    detail: "no heartbeat (worker down or Redis not configured)",
  };
  if (redis) {
    const beat = await check(() => redis.get(WORKER_HEARTBEAT_KEY));
    const at = beat.ok ? beat.value : null;
    if (at) {
      const age = Date.now() - new Date(at).getTime();
      worker = {
        ok: age < WORKER_HEARTBEAT_STALE_MS,
        last_beat: at,
        ...(age >= WORKER_HEARTBEAT_STALE_MS ? { detail: "heartbeat stale" } : {}),
      };
    }
  }

  const queues: Record<string, unknown> = {};
  for (const [name, queue] of [
    ["enrichment", enrichmentQueue],
    ["actions", actionQueue],
  ] as const) {
    if (!queue) {
      queues[name] = null;
      continue;
    }
    const counts = await check(() =>
      queue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
    );
    queues[name] = counts.ok ? counts.value : { error: counts.error };
  }

  const totals = await check(async () => {
    const media = await db.query(
      `SELECT count(*) AS objects, coalesce(sum(bytes),0) AS bytes,
              coalesce(sum(thumb_bytes),0) AS thumb_bytes
       FROM moment_media`,
    );
    const pendingDeletes = await db.query(`SELECT count(*) AS n FROM media_delete_queue`);
    const failedActions = await db.query(
      `SELECT count(*) AS n FROM actions WHERE status = 'failed'`,
    );
    const users = await db.query(`SELECT count(*) AS n FROM users`);
    const moments = await db.query(`SELECT count(*) AS n FROM context_moments`);
    return {
      users: Number(users.rows[0]!.n),
      moments: Number(moments.rows[0]!.n),
      media_objects: Number(media.rows[0]!.objects),
      media_bytes: Number(media.rows[0]!.bytes),
      thumbnail_bytes: Number(media.rows[0]!.thumb_bytes),
      pending_media_deletes: Number(pendingDeletes.rows[0]!.n),
      failed_actions: Number(failedActions.rows[0]!.n),
    };
  });

  const lastMaintenance = await check(async () => {
    const { rows } = await db.query(
      `SELECT mode, report, ran_at FROM ops_maintenance_runs ORDER BY ran_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  });

  // M13 cost/usage visibility: which cloud features are live (each is
  // opt-in by design) so the operator can see — and kill — spend quickly.
  const features = {
    live_qa:
      deps.env.NOVA_LIVE_QA !== "off" && deps.env.ANTHROPIC_API_KEY ? "on" : "off",
    transcription: deps.env.OPENAI_API_KEY ? "on" : "off",
    search_embeddings: deps.env.OPENAI_API_KEY ? "on" : "off",
    analytics: deps.env.NOVA_ANALYTICS,
    text_redaction: deps.env.NOVA_REDACTION,
    image_redaction: deps.env.NOVA_IMAGE_REDACTION,
    screenshot_storage: deps.env.NOVA_SCREENSHOT_STORAGE,
    notion: deps.env.NOTION_CLIENT_ID ? "configured" : "off",
    // Cloud enrichment is a WORKER setting; the API reports observed usage
    // instead (enrichment_versions by provider — see ops:report).
  };

  // M13 guardrails: conditions worth acting on, as flags, not pages.
  const warnings: string[] = [];
  if (!worker.ok) warnings.push("worker heartbeat missing/stale");
  if (totals.ok) {
    const t = totals.value!;
    const warnBytes = deps.env.NOVA_MEDIA_WARN_MB * 1024 * 1024;
    if (t.media_bytes + t.thumbnail_bytes > warnBytes) {
      warnings.push(
        `media storage above ${deps.env.NOVA_MEDIA_WARN_MB}MB threshold — review usage / run media:cleanup`,
      );
    }
    if (t.pending_media_deletes > 0) {
      warnings.push(`${t.pending_media_deletes} pending media delete(s) — run media:cleanup -- --delete`);
    }
    if (t.failed_actions > 0) {
      warnings.push(`${t.failed_actions} failed action(s) — see ops:report / ops:maintenance`);
    }
  }

  return {
    ready: ready.ready,
    checks: ready.checks,
    worker,
    queues,
    totals: totals.ok ? totals.value : { error: totals.error },
    features,
    warnings,
    last_maintenance: lastMaintenance.ok ? lastMaintenance.value : null,
    version: deps.env.NOVA_GIT_SHA ?? null,
    generated_at: new Date().toISOString(),
  };
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDeps): void {
  app.get("/readyz", async (req, reply) => {
    const result = await readiness(deps);
    return reply.code(result.ready ? 200 : 503).send(result);
  });

  // Under /v1 → the fail-closed auth middleware applies: session required.
  app.get("/v1/ops/status", async () => opsStatus(deps));
}
