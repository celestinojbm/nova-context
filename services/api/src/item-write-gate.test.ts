import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemWriteGate, TimedSemaphore, defaultItemLockConnections } from "./item-write-gate.js";

describe("TimedSemaphore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("grants up to capacity immediately, then hands off FIFO on release", async () => {
    const s = new TimedSemaphore(2);
    expect(await s.acquire(100)).toBe(true);
    expect(await s.acquire(100)).toBe(true);
    const order: string[] = [];
    const a = s.acquire(1000).then((ok) => order.push(`a:${ok}`));
    const b = s.acquire(1000).then((ok) => order.push(`b:${ok}`));
    s.release();
    await a;
    s.release();
    await b;
    expect(order).toEqual(["a:true", "b:true"]);
    s.release();
    s.release();
    expect(s.idle).toBe(true);
  });

  it("a waiter that times out is dropped and does not consume the next release", async () => {
    const s = new TimedSemaphore(1);
    await s.acquire(0);
    const late = s.acquire(50);
    const patient = s.acquire(1000);
    await vi.advanceTimersByTimeAsync(60);
    expect(await late).toBe(false);
    s.release();
    expect(await patient).toBe(true);
  });

  it("a non-positive timeout never waits", async () => {
    const s = new TimedSemaphore(1);
    await s.acquire(0);
    expect(await s.acquire(0)).toBe(false);
    expect(await s.acquire(-5)).toBe(false);
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => new TimedSemaphore(0)).toThrow();
  });
});

describe("ItemWriteGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets only one request per item through; the next one gets in when it releases", async () => {
    const g = new ItemWriteGate(5);
    const first = await g.enter("item-1", Date.now() + 1000);
    expect(first).not.toBeNull();
    let secondIn = false;
    const second = g.enter("item-1", Date.now() + 1000).then((r) => ((secondIn = true), r));
    await vi.advanceTimersByTimeAsync(10);
    expect(secondIn).toBe(false);
    first!();
    const r2 = await second;
    expect(r2).not.toBeNull();
    r2!();
    expect(g.trackedItems).toBe(0);
  });

  it("different items do not block each other (up to the global cap)", async () => {
    const g = new ItemWriteGate(2);
    const a = await g.enter("a", Date.now() + 100);
    const b = await g.enter("b", Date.now() + 100);
    expect(a && b).toBeTruthy();
    // Third distinct item: global cap reached → waits, then times out at the deadline.
    const c = g.enter("c", Date.now() + 100);
    await vi.advanceTimersByTimeAsync(150);
    expect(await c).toBeNull();
    a!();
    b!();
    expect(g.trackedItems).toBe(0);
  });

  it("a request that times out on the global cap frees its item slot", async () => {
    const g = new ItemWriteGate(1);
    const a = await g.enter("a", Date.now() + 1000);
    const b1 = g.enter("b", Date.now() + 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await b1).toBeNull();
    a!();
    const b2 = await g.enter("b", Date.now() + 50);
    expect(b2).not.toBeNull();
    b2!();
  });

  it("an expired deadline is refused without waiting; release is idempotent", async () => {
    const g = new ItemWriteGate(1);
    const a = await g.enter("a", Date.now() + 1000);
    expect(await g.enter("a", Date.now() - 1)).toBeNull();
    a!();
    a!(); // double release must not free a slot that is not held
    const x = await g.enter("x", Date.now() + 10);
    expect(x).not.toBeNull();
    expect(await g.enter("y", Date.now() + 0)).toBeNull();
    x!();
  });

  it("defaults to half the pool, at least one connection", () => {
    expect(defaultItemLockConnections(10)).toBe(5);
    expect(defaultItemLockConnections(undefined)).toBe(5);
    expect(defaultItemLockConnections(1)).toBe(1);
    expect(defaultItemLockConnections(3)).toBe(1);
  });
});
