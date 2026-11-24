/**
 * M20h review fix: keep the opt-in memory-item write lock from draining the pg pool.
 *
 * The row lock (SELECT … FOR UPDATE) can only be waited on while holding a pool
 * connection, so N concurrent PATCHes of one hot item used to park min(N, pool.max)
 * connections on that lock and starve every other route. This gate makes waiters
 * queue IN MEMORY instead, before a connection is checked out:
 *
 *  - per item: at most one request per process holds a connection for a given item
 *    (the rest wait for their turn without a connection);
 *  - global: at most `maxConnections` connections are used by this path at once,
 *    so many different hot items cannot drain the pool either.
 *
 * Both waits share the caller's single deadline; a waiter that does not get in
 * before it gets `null` (→ 429). Across replicas the Postgres row lock still does
 * the serialization; each replica then holds at most one connection per item.
 */

interface Waiter {
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Counting semaphore with FIFO hand-off and a per-acquire timeout. */
export class TimedSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`capacity must be an integer >= 1 (got ${capacity})`);
  }

  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  /** Resolves true once a slot is held, false if `timeoutMs` elapses first. */
  acquire(timeoutMs: number): Promise<boolean> {
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve(true);
    }
    if (!(timeoutMs > 0)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          resolve(false);
        }, timeoutMs),
      };
      this.queue.push(w);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter: `active` stays the same.
      clearTimeout(next.timer);
      next.resolve(true);
    } else if (this.active > 0) {
      this.active--;
    }
  }
}

export class ItemWriteGate {
  private readonly perItem = new Map<string, TimedSemaphore>();
  private readonly global: TimedSemaphore;

  constructor(readonly maxConnections: number) {
    this.global = new TimedSemaphore(Math.max(1, Math.floor(maxConnections)));
  }

  /** Items with a holder or waiters right now (for tests/diagnostics). */
  get trackedItems(): number {
    return this.perItem.size;
  }

  /**
   * Wait (without a DB connection) until this request may use one for `key`.
   * Returns an idempotent release function, or null if `deadline` (epoch ms) passed first.
   * Order is per-item first, then global, so a hot item's queue never occupies global slots.
   */
  async enter(key: string, deadline: number): Promise<(() => void) | null> {
    let item = this.perItem.get(key);
    if (!item) {
      item = new TimedSemaphore(1);
      this.perItem.set(key, item);
    }
    if (!(await item.acquire(deadline - Date.now()))) {
      this.forget(key, item);
      return null;
    }
    if (!(await this.global.acquire(deadline - Date.now()))) {
      item.release();
      this.forget(key, item);
      return null;
    }
    let released = false;
    const held = item;
    return () => {
      if (released) return;
      released = true;
      this.global.release();
      held.release();
      this.forget(key, held);
    };
  }

  private forget(key: string, item: TimedSemaphore): void {
    if (item.idle && this.perItem.get(key) === item) this.perItem.delete(key);
  }
}

/** Default share of the pool the lock path may use: half of it, at least one. */
export function defaultItemLockConnections(poolMax: number | undefined): number {
  return Math.max(1, Math.floor((poolMax ?? 10) / 2));
}
