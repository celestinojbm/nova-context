import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

/**
 * M15 (Hermes P2): a Redis outage must NOT turn credential surfaces into an
 * unlimited guessing oracle. When Redis is unreachable the limiter falls
 * back to a fail-closed in-memory window and reports degraded state.
 */
describe("rate limiter Redis-failure fallback", () => {
  it("in-memory backend enforces the window and is never 'degraded'", async () => {
    const rl = createRateLimiter(undefined, { windowMs: 60_000, max: 2 });
    expect(await rl.allow("k")).toBe(true);
    expect(await rl.allow("k")).toBe(true);
    expect(await rl.allow("k")).toBe(false); // 3rd over max=2
    expect(rl.status()).toEqual({ backend: "memory", degraded: false, last_error_at: null });
    await rl.close();
  });

  it("Redis unreachable → fails CLOSED via in-memory fallback, marks degraded", async () => {
    const warnings: string[] = [];
    // Port 1 is unbindable → every Redis op errors immediately.
    const rl = createRateLimiter("redis://127.0.0.1:1", {
      windowMs: 60_000,
      max: 3,
      prefix: `rltest-${Math.random().toString(36).slice(2)}`,
      warn: (event) => warnings.push(event),
    });
    // The window still bounds attempts even though Redis is dead.
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await rl.allow("attacker-ip"));
    expect(results.slice(0, 3)).toEqual([true, true, true]);
    expect(results.slice(3)).toEqual([false, false]); // NOT unlimited

    const status = rl.status();
    expect(status.backend).toBe("redis");
    expect(status.degraded).toBe(true);
    expect(status.last_error_at).not.toBeNull();
    expect(warnings).toContain("rate_limit_redis_unavailable");
    await rl.close();
  });
});
