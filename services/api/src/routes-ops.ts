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
async function probeStore(store: ObjectStore): Promise<void> {
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

  return {
    ready: ready.ready,
    checks: ready.checks,
    worker,
    queues,
    totals: totals.ok ? totals.value : { error: totals.error },
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
