import { Redis } from "ioredis";

/**
 * Fixed-window rate limiting for credential-guessing surfaces (M5, upgraded
 * in M7). With REDIS_URL the window is shared across API instances
 * (INCR + PEXPIRE); without it, the M5 in-memory limiter remains as the
 * single-instance fallback. Redis errors fail OPEN with a log line: locking
 * every user out because Redis blipped is the worse failure for an alpha —
 * documented trade-off.
 */
export interface RateLimiter {
  allow(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Redis key namespace (test isolation across suites/runs). */
  prefix?: string;
}

class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly opts: RateLimitOptions) {}

  async allow(key: string): Promise<boolean> {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.opts.max;
  }

  async close(): Promise<void> {
    this.hits.clear();
  }
}

class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  constructor(
    redisUrl: string,
    private readonly opts: RateLimitOptions,
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
    this.redis.on("error", () => {
      /* surfaced per-call below; never crash the process */
    });
  }

  async allow(key: string): Promise<boolean> {
    const redisKey = `${this.opts.prefix ?? "nova:ratelimit"}:${key}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.pexpire(redisKey, this.opts.windowMs);
      }
      return count <= this.opts.max;
    } catch (err) {
      console.error(`[rate-limit] redis unavailable, failing open: ${(err as Error).message}`);
      return true;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

export function createRateLimiter(
  redisUrl: string | undefined,
  opts: RateLimitOptions,
): RateLimiter {
  return redisUrl ? new RedisRateLimiter(redisUrl, opts) : new MemoryRateLimiter(opts);
}
