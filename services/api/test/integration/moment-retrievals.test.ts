import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Analytics } from "../../src/analytics.js";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * Retrieval instrumentation (migration 0020) for the theory's falsification
 * test: a text-query search records which moments it returned (counter +
 * best rank), and nothing else. Recording is fire-and-forget, so assertions
 * poll the table instead of assuming the row is there when the search
 * response arrives.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("moment retrievals (falsification-test instrumentation)", () => {
  let app: FastifyInstance;
  let appOff: FastifyInstance;
  let db: pg.Pool;
  let alice: TestUser;
  let bob: TestUser;
  const stamp = Date.now();
  // A token unique to this run so other suites' moments never match.
  const WORD = `quokka${stamp}`;
  const SECRET = `retrieval secret page text ${stamp}`;
  let strong: string; // matches the query twice → ranks first
  let weak: string;
  let unrelated: string;

  async function capture(user: TestUser, text: string): Promise<string> {
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://example.com/retrieval", title: "Retrieval" },
        extracted_text: text,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function search(
    user: TestUser,
    body: Record<string, unknown>,
  ): Promise<string[]> {
    const res = await user.inject({ method: "POST", url: "/v1/memory/search", payload: body });
    expect(res.statusCode).toBe(200);
    return (res.json().items as Array<{ id: string }>).map((i) => i.id);
  }

  async function rowsFor(ids: string[]) {
    const { rows } = await db.query<{
      moment_id: string;
      user_id: string;
      search_hits: number;
      best_rank: number;
    }>(
      `SELECT moment_id, user_id, search_hits, best_rank FROM moment_retrievals
       WHERE moment_id = ANY($1::uuid[]) ORDER BY best_rank`,
      [ids],
    );
    return rows;
  }

  /** Poll until `check` passes (fire-and-forget write) or time out. */
  async function eventually(check: () => Promise<void>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await check();
        return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /** Let any in-flight fire-and-forget write land before asserting absence. */
  const settle = () => new Promise((r) => setTimeout(r, 300));

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_RATE_LIMIT_PREFIX: `test-retrievals-${stamp}`,
      }),
    });
    await app.ready();
    appOff = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ANALYTICS: "off",
        NOVA_RATE_LIMIT_PREFIX: `test-retrievals-off-${stamp}`,
      }),
    });
    await appOff.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 3 });

    alice = await createUser(app, `retrievals-alice-${stamp}@example.test`);
    bob = await createUser(app, `retrievals-bob-${stamp}@example.test`);
    strong = await capture(alice, `${WORD} ${WORD} ${SECRET}`);
    weak = await capture(alice, `${WORD} ${SECRET} with a lot more unrelated words around it`);
    unrelated = await capture(alice, `nothing to see here ${SECRET}`);
  });

  afterAll(async () => {
    await db?.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [alice?.userId, bob?.userId].filter(Boolean),
    ]);
    await db?.end();
    await app?.close();
    await appOff?.close();
  });

  it("records the moments a text search returned, with their rank", async () => {
    const ids = await search(alice, { query: WORD });
    expect(ids).toEqual([strong, weak]);
    await eventually(async () => {
      const rows = await rowsFor([strong, weak, unrelated]);
      expect(rows.map((r) => [r.moment_id, r.search_hits, r.best_rank])).toEqual([
        [strong, 1, 1],
        [weak, 1, 2],
      ]);
      expect(rows.every((r) => r.user_id === alice.userId)).toBe(true);
    });
  });

  it("counts repeat retrievals and keeps the best rank ever reached", async () => {
    // Filtered to `weak` alone, it now ranks first.
    await search(alice, { query: `${WORD} lot more unrelated words` });
    await eventually(async () => {
      const rows = await rowsFor([strong, weak]);
      const byId = new Map(rows.map((r) => [r.moment_id, r]));
      expect(byId.get(weak)).toMatchObject({ search_hits: 2, best_rank: 1 });
      expect(byId.get(strong)!.best_rank).toBe(1);
    });
  });

  it("does not count filter-only listings (browsing is not recall)", async () => {
    const ids = await search(alice, { limit: 50 });
    expect(ids).toContain(unrelated);
    await settle();
    expect(await rowsFor([unrelated])).toEqual([]);
  });

  it("honors the analytics off-switch", async () => {
    const offAlice = await createUser(appOff, alice.email);
    const before = await rowsFor([strong]);
    const ids = await search(offAlice, { query: `nothing to see here` });
    expect(ids).toContain(unrelated);
    await settle();
    expect(await rowsFor([unrelated])).toEqual([]);
    expect(await rowsFor([strong])).toEqual(before);
  });

  it("never records another user's moment, even if handed its id", async () => {
    const analytics = new Analytics(db, true);
    await analytics.trackRetrievals(bob.userId, [unrelated]);
    expect(await rowsFor([unrelated])).toEqual([]);
    // Bob's own searches cannot reach Alice's moments either.
    expect(await search(bob, { query: WORD })).toEqual([]);
  });

  it("stores no content and no query text", async () => {
    const { rows } = await db.query(
      `SELECT * FROM moment_retrievals WHERE user_id = $1`,
      [alice.userId],
    );
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(WORD);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "best_rank",
        "first_retrieved_at",
        "last_retrieved_at",
        "moment_id",
        "search_hits",
        "user_id",
      ].sort(),
    );
  });

  it("is part of the account export", async () => {
    const res = await alice.inject({ method: "GET", url: "/v1/export/account" });
    expect(res.statusCode).toBe(200);
    const exported = res.json().moment_retrievals as Array<{ moment_id: string }>;
    expect(exported.map((r) => r.moment_id).sort()).toEqual([strong, weak].sort());
  });

  it("goes away with the moment", async () => {
    const res = await alice.inject({ method: "DELETE", url: `/v1/context/moments/${weak}` });
    expect(res.statusCode).toBeLessThan(300);
    expect(await rowsFor([weak])).toEqual([]);
    expect((await rowsFor([strong])).length).toBe(1);
  });
});
