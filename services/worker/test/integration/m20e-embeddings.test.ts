import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConsolidation } from "../../src/memory/consolidate.js";
import { THRESHOLDS } from "../../src/memory/consolidation-rules.js";
import type { Embedder } from "../../src/memory/embeddings.js";
import { factHash } from "../../src/memory/fact-extractor.js";

/** M20e: embedding candidates in consolidation, with a fake embedder (CI never loads the model). */
const databaseUrl = process.env.DATABASE_URL;
const fake: Embedder = {
  model: "test/fake-384",
  dim: 384,
  async embed(texts) {
    // "car" facts share one direction, everything else another → cosine 1 vs 0.
    return texts.map((t) => {
      const v = new Float32Array(384);
      v[/car|coche|mazda|honda/i.test(t) ? 0 : 1] = 1;
      return v;
    });
  },
};

describe.skipIf(!databaseUrl)(
  "M20e embeddings → consolidation candidates (integration)",
  () => {
    let db: pg.Pool;
    let userId: string;
    beforeAll(async () => {
      db = new pg.Pool({ connectionString: databaseUrl });
      userId = (
        await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
          `m20e-${Date.now()}@nova.local`,
        ])
      ).rows[0].id;
      const ns = (
        await db.query(
          `INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, 'eval/m20e', 'custom') RETURNING id`,
          [userId],
        )
      ).rows[0].id;
      for (const [f, at] of [
        ["Drives a Mazda", "2026-01-01"],
        ["My new car is a Honda", "2026-06-01"],
        ["Likes jazz", "2026-02-01"],
      ] as const)
        await db.query(
          `INSERT INTO memory_items (user_id, layer, content, status, valid_from, author, content_hash, namespace_id)
         VALUES ($1, 'semantic', $2, 'active', $3, 'model', $4, $5)`,
          [userId, f, at, factHash(f), ns],
        );
    });
    afterAll(async () => {
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await db.end();
    });

    it("without an embedder, low-trigram paraphrases are not candidates", async () => {
      const { report } = await runConsolidation(db, userId);
      expect(report).toMatchObject({
        conflicts_newer_wins: 0,
        embedding_candidates: 0,
      });
    });

    it("with an embedder: stores vectors, adds the semantic pair, dry-run changes nothing", async () => {
      const { report } = await runConsolidation(
        db,
        userId,
        "dry-run",
        THRESHOLDS,
        fake,
      );
      expect(report).toMatchObject({
        embedding_candidates: 1,
        conflicts_newer_wins: 1,
        merges: 0,
      });
      const n = (
        await db.query(
          `SELECT count(*)::int n FROM memory_item_embeddings e JOIN memory_items m ON m.id = e.memory_item_id WHERE m.user_id = $1`,
          [userId],
        )
      ).rows[0].n;
      expect(n).toBe(3);
      const changed = (
        await db.query(
          `SELECT count(*)::int n FROM memory_items WHERE user_id = $1 AND status <> 'active'`,
          [userId],
        )
      ).rows[0].n;
      expect(changed).toBe(0);
    });
  },
);
