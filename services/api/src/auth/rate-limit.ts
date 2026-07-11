import { Redis } from "ioredis";

/**
 * Fixed-window rate limiting for credential-guessing surfaces (M5, upgraded
 * in M7). With REDIS_URL the window is shared across API instances
 * (INCR + PEXPIRE); without it, the in-memory limiter is the single-instance
 * mode.
 *
 * M15 (Hermes P2): Redis failure NO LONGER fails open. When Redis is
 * unreachable the limiter falls back to a LOCAL in-memory window so a Redis
 * blip cannot turn login/signup/pairing/reset/delete into an unlimited
 * guessing oracle. The fallback is per-instance (weaker than the shared
 * window but still bounded), a structured security warning is emitted, and
 * the degraded state is exposed via status() for /status and preflight.
 */
export interface RateLimiterStatus {
  backend: "redis" | "memory";
  /** True when a Redis-backed limiter is currently serving from its local
   * fallback because Redis is unreachable. Always false for the pure
   * in-memory backend (that is a configuration, not a degradation). */
  degraded: boolean;
  last_error_at: string | null;
}

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
  status(): RateLimiterStatus;
  close(): Promise<void>;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Redis key namespace (test isolation across suites/runs). */
  prefix?: string;
  /** Structured warning sink (defaults to a JSON line on stderr). Receives
   * an event name + content-free detail — never keys or captured content. */
  warn?: (event: string, detail: Record<string, unknown>) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  async allow(key: string): Promise<boolean> {
    return this.allowSync(key);
  }

  /** Synchronous core so a Redis limiter can reuse it as its fallback. */
  allowSync(key: string): boolean {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.opts.max;
  }

  status(): RateLimiterStatus {
    return { backend: "memory", degraded: false, last_error_at: null };
  }

  async close(): Promise<void> {
    this.hits.clear();
  }
}

class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  private readonly fallback: MemoryRateLimiter;
  private readonly warn: (event: string, detail: Record<string, unknown>) => void;
  private readonly now: () => number;
  private degraded = false;
  private lastErrorAt: number | null = null;

  constructor(
    redisUrl: string,
    private readonly opts: RateLimitOptions,
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
    this.redis.on("error", () => {
      /* surfaced per-call below; never crash the process */
    });
    this.fallback = new MemoryRateLimiter(opts);
    this.now = opts.now ?? Date.now;
    this.warn =
      opts.warn ??
      ((event, detail) =>
        // Content-free structured line: event name + error class only.
        console.warn(JSON.stringify({ level: "warn", event, ...detail })));
  }

  async allow(key: string): Promise<boolean> {
    const redisKey = `${this.opts.prefix ?? "nova:ratelimit"}:${key}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.pexpire(redisKey, this.opts.windowMs);
      }
      if (this.degraded) {
        this.degraded = false; // Redis recovered
        this.warn("rate_limit_redis_recovered", { backend: "redis" });
      }
      return count <= this.opts.max;
    } catch (err) {
      // FAIL CLOSED: count the attempt against the local fallback window so
      // Redis being down never means unlimited attempts.
      if (!this.degraded) {
        this.warn("rate_limit_redis_unavailable", {
          backend: "redis",
          fallback: "memory",
          error_class: (err as Error).name,
        });
      }
      this.degraded = true;
      this.lastErrorAt = this.now();
      return this.fallback.allowSync(key);
    }
  }

  status(): RateLimiterStatus {
    return {
      backend: "redis",
      degraded: this.degraded,
      last_error_at: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
    };
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
    await this.fallback.close();
  }
}

export function createRateLimiter(
  redisUrl: string | undefined,
  opts: RateLimitOptions,
): RateLimiter {
  return redisUrl ? new RedisRateLimiter(redisUrl, opts) : new MemoryRateLimiter(opts);
}
