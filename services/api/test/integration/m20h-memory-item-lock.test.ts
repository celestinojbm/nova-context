import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { authedInject, createUser, type AuthedInject, type TestUser } from "./helpers.js";

/**
 * M20h: opt-in serialization of concurrent PATCHes on one memory item
 * (NOVA_MEMORY_ITEM_LOCK=on) with 429 + Retry-After when the wait exceeds
 * NOVA_MEMORY_ITEM_LOCK_TIMEOUT_MS. Real Postgres row locks, no mocks.
 * Default (off) must keep the historical behavior: never 429, just wait.
 */
const databaseUrl = process.env.DATABASE_URL;
const TIMEOUT_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!databaseUrl)("M20h: memory item write lock", () => {
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;
  let holder: pg.Client;
  let admin: pg.Client;
  let alice: TestUser;
  let onI: AuthedInject;
  let offI: AuthedInject;
  let aliceTokenI: AuthedInject;
  let userItemId: string;
  const base = "/v1/namespaces/asistente/lock-test/memory";

  beforeAll(async () => {
    await migrate(databaseUrl!);
    appOn = await buildApp({
      ocr: null,
      env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_MEMORY_ITEM_LOCK: "on", NOVA_MEMORY_ITEM_LOCK_TIMEOUT_MS: String(TIMEOUT_MS) }),
    });
    appOff = await buildApp({
      ocr: null,
      env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_MEMORY_ITEM_LOCK_TIMEOUT_MS: String(TIMEOUT_MS) }),
    });
    await Promise.all([appOn.ready(), appOff.ready()]);
    holder = new pg.Client({ connectionString: databaseUrl });
    admin = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([holder.connect(), admin.connect()]);
    alice = await createUser(appOn, `alice-m20h-${Date.now()}@test.local`);
    onI = alice.inject;
    offI = authedInject(appOff, alice.token);
    expect((await onI({ method: "POST", url: "/v1/namespaces", payload: { slug: "asistente/lock-test", kind: "assistant" } })).statusCode).toBe(201);
    const issued = await onI({
      method: "POST",
      url: "/v1/namespace-tokens",
      payload: { label: "lock-test", grants: [{ namespace: "asistente/lock-test", scopes: ["memory:read", "memory:write"] }] },
    });
    aliceTokenI = authedInject(appOn, (issued.json() as { token: string }).token);
    const u = await onI({ method: "POST", url: base, payload: { content: "hecho del usuario" } });
    userItemId = u.json().id;
  });
  afterAll(async () => {
    await holder?.end().catch(() => {});
    await admin?.end();
    await Promise.all([appOn?.close(), appOff?.close()]);
  });

  async function newItem(content = "hecho inicial"): Promise<string> {
    const res = await onI({ method: "POST", url: base, payload: { content } });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }
  const row = async (id: string) =>
    (await admin.query<{ content: string; status: string; content_hash: string }>(
      `SELECT content, status, content_hash FROM memory_items WHERE id = $1`,
      [id],
    )).rows[0]!;
  async function holdLock(id: string) {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM memory_items WHERE id = $1 FOR UPDATE`, [id]);
  }

  it("on: a PATCH that waits longer than the timeout gets 429 + Retry-After and changes nothing", async () => {
    const id = await newItem();
    await holdLock(id);
    const t0 = Date.now();
    const res = await onI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "no debe aplicarse" } });
    const waited = Date.now() - t0;
    await holder.query("ROLLBACK");
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("item_busy");
    expect(res.headers["retry-after"]).toBe("1");
    expect(waited).toBeGreaterThanOrEqual(TIMEOUT_MS - 100);
    expect(waited).toBeLessThan(TIMEOUT_MS + 3000);
    expect((await row(id)).content).toBe("hecho inicial");
    // The failed attempt released its connection and lock: the item is writable again.
    expect((await onI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "ya libre" } })).statusCode).toBe(200);
    expect((await row(id)).content).toBe("ya libre");
  });

  it("on: a PATCH that waits less than the timeout is applied after the lock is released", async () => {
    const id = await newItem();
    await holdLock(id);
    const pending = onI({ method: "PATCH", url: `${base}/${id}`, payload: { status: "superseded" } });
    await sleep(150);
    await holder.query("COMMIT");
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect((await row(id)).status).toBe("superseded");
  });

  it("on: concurrent PATCHes of one item are serialized and leave a consistent row", async () => {
    const id = await newItem();
    const contents = Array.from({ length: 12 }, (_, i) => `version concurrente ${i}`);
    const results = await Promise.all(contents.map((content) => onI({ method: "PATCH", url: `${base}/${id}`, payload: { content } })));
    expect(results.map((r) => r.statusCode)).toEqual(contents.map(() => 200));
    const r = await row(id);
    expect(contents).toContain(r.content);
    const expected = (await admin.query<{ h: string }>(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`, [r.content.toLowerCase()])).rows[0]!.h;
    expect(r.content_hash).toBe(expected);
  });

  it("on: locks are per item — another item of the same namespace is not blocked", async () => {
    const locked = await newItem();
    const free = await newItem();
    await holdLock(locked);
    const res = await onI({ method: "PATCH", url: `${base}/${free}`, payload: { content: "libre" } });
    await holder.query("ROLLBACK");
    expect(res.statusCode).toBe(200);
  });

  it("on: unchanged semantics — 404 unknown item, 403 token on a user fact, 400 bad body, token can patch its own", async () => {
    expect((await onI({ method: "PATCH", url: `${base}/00000000-0000-4000-8000-000000000000`, payload: { content: "x" } })).statusCode).toBe(404);
    const denied = await aliceTokenI({ method: "PATCH", url: `${base}/${userItemId}`, payload: { content: "hijack" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("user_fact_protected");
    expect((await row(userItemId)).content).toBe("hecho del usuario");
    expect((await onI({ method: "PATCH", url: `${base}/${userItemId}`, payload: {} })).statusCode).toBe(400);
    const own = await aliceTokenI({ method: "POST", url: base, payload: { content: "hecho del asistente" } });
    expect((await aliceTokenI({ method: "PATCH", url: `${base}/${own.json().id}`, payload: { status: "contested" } })).statusCode).toBe(200);
    // Even an erroring/denied path never leaves a transaction open on the pool.
    const open = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
    expect(open.rows[0].n).toBe(0);
  });

  it("off (default): no serialization and no 429 — the request just waits for the lock", async () => {
    const id = await newItem();
    await holdLock(id);
    const t0 = Date.now();
    const pending = offI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "tras esperar" } });
    await sleep(TIMEOUT_MS + 400); // longer than the configured timeout, which off must ignore
    await holder.query("COMMIT");
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(TIMEOUT_MS);
    expect((await row(id)).content).toBe("tras esperar");
  });
});
