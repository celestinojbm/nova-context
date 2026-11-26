import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embeddedTextHash, runConsolidation } from "../../src/memory/consolidate.js";
import { THRESHOLDS } from "../../src/memory/consolidation-rules.js";
import type { Embedder } from "../../src/memory/embeddings.js";
import { factHash } from "../../src/memory/fact-extractor.js";

/**
 * M20i: a vector is tied to the exact text it was computed from
 * (memory_item_embeddings.content_sha256). Editing a fact makes its vector
 * stale and the next run recomputes it; unchanged facts are never re-embedded.
 */
const databaseUrl = process.env.DATABASE_URL;

/** Fake 384-dim embedder: "car" facts → axis 0, the rest → axis 1. Records every text it embeds. */
function countingEmbedder(): Embedder & { seen: string[] } {
  const seen: string[] = [];
  return {
    model: "test/fake-384-m20i",
    dim: 384,
    seen,
    async embed(texts) {
      seen.push(...texts);
      return texts.map((t) => {
        const v = new Float32Array(384);
        v[/car|coche|mazda|honda/i.test(t) ? 0 : 1] = 1;
        return v;
      });
    },
  };
}

describe.skipIf(!databaseUrl)("M20i stale embeddings after an edit (integration)", () => {
  let db: pg.Pool;
  let userId: string;
  const ids: Record<string, string> = {};
  const vectorAxis = async (id: string, model: string) =>
    (
      await db.query<{ axis0: number; h: string | null }>(
        `SELECT (embedding::real[])[1] AS axis0, content_sha256 AS h
         FROM memory_item_embeddings WHERE memory_item_id = $1 AND model = $2`,
        [id, model],
      )
    ).rows[0];

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: databaseUrl });
    userId = (
      await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`m20i-${Date.now()}@nova.local`])
    ).rows[0].id;
    const ns = (
      await db.query(
        `INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, 'eval/m20i', 'custom') RETURNING id`,
        [userId],
      )
    ).rows[0].id;
    for (const [key, f, at] of [
      ["mazda", "Drives a Mazda", "2026-01-01"],
      ["jazz", "Likes jazz", "2026-02-01"],
      ["tea", "Drinks green tea", "2026-03-01"],
    ] as const)
      ids[key] = (
        await db.query(
          `INSERT INTO memory_items (user_id, layer, content, status, valid_from, author, content_hash, namespace_id)
           VALUES ($1, 'semantic', $2, 'active', $3, 'model', $4, $5) RETURNING id`,
          [userId, f, at, factHash(f), ns],
        )
      ).rows[0].id;
  });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await db.end();
  });

  it("first run embeds every fact and stores the hash of the exact text", async () => {
    const e = countingEmbedder();
    const { report } = await runConsolidation(db, userId, "dry-run", THRESHOLDS, e);
    expect(e.seen.sort()).toEqual(["Drinks green tea", "Drives a Mazda", "Likes jazz"]);
    expect(report.embeddings_refreshed).toBe(0);
    expect((await vectorAxis(ids.mazda!, e.model))!.h).toBe(embeddedTextHash("Drives a Mazda"));
  });

  it("a second run with no edits embeds nothing", async () => {
    const e = countingEmbedder();
    const { report } = await runConsolidation(db, userId, "dry-run", THRESHOLDS, e);
    expect(e.seen).toEqual([]);
    expect(report.embeddings_refreshed).toBe(0);
  });

  it("an edited fact is re-embedded (only that one) and the new meaning drives candidates", async () => {
    // "Likes jazz" → a car fact: with the old vector it would stay on axis 1
    // and never pair with the Mazda fact.
    await db.query(`UPDATE memory_items SET content = $2, content_hash = $3 WHERE id = $1`, [
      ids.jazz,
      "My new car is a Honda",
      factHash("My new car is a Honda"),
    ]);
    const e = countingEmbedder();
    const { report } = await runConsolidation(db, userId, "dry-run", THRESHOLDS, e);
    expect(e.seen).toEqual(["My new car is a Honda"]);
    expect(report.embeddings_refreshed).toBe(1);
    expect(report.embedding_candidates).toBe(1);
    const row = (await vectorAxis(ids.jazz!, e.model))!;
    expect(row.axis0).toBe(1);
    expect(row.h).toBe(embeddedTextHash("My new car is a Honda"));
  });

  it("a whitespace/case-only edit is still a new model input and is re-embedded", async () => {
    await db.query(`UPDATE memory_items SET content = 'drinks green tea' WHERE id = $1`, [ids.tea]);
    const e = countingEmbedder();
    const { report } = await runConsolidation(db, userId, "dry-run", THRESHOLDS, e);
    expect(e.seen).toEqual(["drinks green tea"]);
    expect(report.embeddings_refreshed).toBe(1);
  });

  it("a vector written before 0019 (no hash) is refreshed once, then left alone", async () => {
    const model = countingEmbedder().model;
    await db.query(`UPDATE memory_item_embeddings SET content_sha256 = NULL WHERE memory_item_id = $1 AND model = $2`, [
      ids.mazda,
      model,
    ]);
    const first = countingEmbedder();
    expect((await runConsolidation(db, userId, "dry-run", THRESHOLDS, first)).report.embeddings_refreshed).toBe(1);
    expect(first.seen).toEqual(["Drives a Mazda"]);
    const second = countingEmbedder();
    expect((await runConsolidation(db, userId, "dry-run", THRESHOLDS, second)).report.embeddings_refreshed).toBe(0);
    expect(second.seen).toEqual([]);
  });

  it("dry-run never touches memory_items", async () => {
    const changed = (
      await db.query(`SELECT count(*)::int n FROM memory_items WHERE user_id = $1 AND status <> 'active'`, [userId])
    ).rows[0].n;
    expect(changed).toBe(0);
  });
});
