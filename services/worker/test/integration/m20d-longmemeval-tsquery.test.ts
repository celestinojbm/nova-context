import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgTsQuery } from "../../src/eval/longmemeval-metrics.js";

/**
 * `pnpm eval:longmemeval -- --pg` ranks with to_tsquery('simple', ·). Every
 * non-null pgTsQuery output must be a valid tsquery in real Postgres; null means
 * the eval does not query at all (the old "''" fallback was a syntax error).
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("M20d --pg tsquery against Postgres (integration)", () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: databaseUrl });
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
  });

  it("the old fallback really is a tsquery syntax error (what the fix avoids)", async () => {
    await expect(c.query("SELECT to_tsquery('simple', $1)", ["''"])).rejects.toThrow(/syntax error in tsquery/);
  });

  it.each([
    "a", "?", "& | !", "'", "a'", "é", "   ", "what is it", "what's & my | car!: (mazda) <-> 'rojo'",
    "a:*", "!!x", "foo\\bar", "¿Qué coche tiene el usuario?", "100% & 2x", "日本 に 行った", "naïve café",
  ])("q=%j → no query, or a tsquery Postgres accepts", async (q) => {
    const tsq = pgTsQuery(q);
    if (tsq === null) return;
    const { rows } = await c.query<{ r: number }>(
      "SELECT ts_rank(to_tsvector('simple', $2), to_tsquery('simple', $1), 1) AS r",
      [tsq, `${q} mazda rojo`],
    );
    expect(rows[0]!.r).toBeGreaterThanOrEqual(0);
  });
});
