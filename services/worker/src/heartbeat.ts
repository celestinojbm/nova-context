import { Redis } from "ioredis";

/**
 * M11 worker readiness: a heartbeat key in Redis, refreshed every 30s with
 * a 90s TTL. The API's /v1/ops/status (and the web status page) reports
 * the worker as up/stale/down from this alone — the worker keeps having
 * no HTTP surface by design.
 */
export const WORKER_HEARTBEAT_KEY = "nova:heartbeat:worker";
const INTERVAL_MS = 30_000;
const TTL_SECONDS = 90;

export function startHeartbeat(redisUrl: string): { stop: () => Promise<void> } {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const beat = async (): Promise<void> => {
    try {
      await redis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), "EX", TTL_SECONDS);
    } catch {
      // Redis blips must never kill the worker; the stale TTL tells the
      // status page the truth on its own.
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), INTERVAL_MS);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      redis.disconnect();
    },
  };
}
