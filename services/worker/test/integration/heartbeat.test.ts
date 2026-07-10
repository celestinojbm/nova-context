import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { startHeartbeat, WORKER_HEARTBEAT_KEY } from "../../src/heartbeat.js";

/**
 * M11 worker readiness: the heartbeat key appears in Redis with a TTL, so
 * the API status page can tell up / stale / down without the worker ever
 * exposing HTTP.
 */
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)("M11: worker heartbeat", () => {
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });

  afterAll(() => {
    redis.disconnect();
  });

  it("writes a fresh, expiring heartbeat and stops cleanly", async () => {
    await redis.del(WORKER_HEARTBEAT_KEY);
    const heartbeat = startHeartbeat(redisUrl!);
    try {
      // The first beat is immediate (fire-and-forget) — give it a moment.
      let value: string | null = null;
      for (let i = 0; i < 20 && !value; i++) {
        await new Promise((r) => setTimeout(r, 100));
        value = await redis.get(WORKER_HEARTBEAT_KEY);
      }
      expect(value).toBeTruthy();
      const age = Date.now() - new Date(value!).getTime();
      expect(age).toBeLessThan(10_000);
      const ttl = await redis.ttl(WORKER_HEARTBEAT_KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(90);
    } finally {
      await heartbeat.stop();
    }
  });
});
