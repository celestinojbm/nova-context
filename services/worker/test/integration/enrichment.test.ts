import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@nova/model-router";
import { enrichMoment, markFailed } from "../../src/enrich.js";
import { loadEnv } from "../../src/env.js";
import { startWorker } from "../../src/worker.js";

/**
 * Worker integration tests: enrichment status transitions, storage writes,
 * and BullMQ failure/retry behavior against real Postgres + Redis.
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const QUEUE = "test-worker-enrich";

describe.skipIf(!databaseUrl || !redisUrl)("enrichment worker (integration)", () => {
  let db: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: databaseUrl });
    const user = await db.query(
      "SELECT id FROM users WHERE email = 'dev@nova.local'",
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    await db?.end();
  });

  async function createMoment(intentText: string | null): Promise<string> {
    const intent = intentText
      ? {
          action_type: "research",
          project_hint: null,
          summary: intentText.slice(0, 100),
          priority_guess: "normal",
          confidence: 0.6,
          parser: "heuristic",
          model: null,
        }
      : null;
    const { rows } = await db.query(
      `INSERT INTO context_moments
         (user_id, source_mode, source_meta, payload, extracted_text, intent_text, intent_parsed, enrichment_status)
       VALUES ($1, 'instant_capture', $2, '{}', $3, $4, $5, 'pending')
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          url: "https://enrich-test.example.com/widget",
          title: "Widget Comparison Guide",
        }),
        "The complete widget comparison guide for enterprise buyers.",
        intentText,
        intent ? JSON.stringify(intent) : null,
      ],
    );
    return rows[0].id;
  }

  it("transitions pending → completed and writes all enrichment outputs", async () => {
    const momentId = await createMoment("compare these widgets with alternatives");
    const result = await enrichMoment(db, { enricher: null, embedder: null }, momentId);

    expect(result.provider).toBe("heuristic");
    expect(result.embedded).toBe(false);
    expect(result.tags.length).toBeGreaterThan(0);

    const { rows } = await db.query(
      `SELECT enrichment_status, summary, enrichment, enriched_at, enrichment_error
       FROM context_moments WHERE id = $1`,
      [momentId],
    );
    expect(rows[0].enrichment_status).toBe("completed");
    expect(rows[0].summary).toBeTruthy();
    expect(rows[0].enriched_at).not.toBeNull();
    expect(rows[0].enrichment_error).toBeNull();
    expect(rows[0].enrichment.provider).toBe("heuristic");

    // Entities: url host mention exists.
    const entities = await db.query(
      `SELECT e.kind, e.name FROM entity_mentions em
       JOIN entities e ON e.id = em.entity_id WHERE em.moment_id = $1`,
      [momentId],
    );
    expect(entities.rows).toContainEqual({
      kind: "url",
      name: "enrich-test.example.com",
    });

    // Research intent with no existing task → one proposed action.
    const actions = await db.query(
      "SELECT status, action_type, risk_tier FROM actions WHERE moment_id = $1",
      [momentId],
    );
    expect(actions.rows).toEqual([
      { status: "proposed", action_type: "nova_task", risk_tier: 0 },
    ]);

    // Audit trail, payload-free.
    const audit = await db.query(
      `SELECT detail FROM audit_log
       WHERE event_type = 'enrichment.completed' AND subject_id = $1`,
      [momentId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("is idempotent: re-running does not duplicate proposals or mentions", async () => {
    const momentId = await createMoment("research widget vendors");
    await enrichMoment(db, { enricher: null, embedder: null }, momentId);
    await enrichMoment(db, { enricher: null, embedder: null }, momentId);
    const actions = await db.query(
      "SELECT count(*)::int AS n FROM actions WHERE moment_id = $1",
      [momentId],
    );
    expect(actions.rows[0].n).toBe(1);
  });

  it("writes an embedding when an embedder is configured", async () => {
    const fakeEmbedder: EmbeddingProvider = {
      name: "fake",
      model: "fake-embed",
      dimensions: 1536,
      embed: () => Promise.resolve(Array.from({ length: 1536 }, (_, i) => (i % 7) / 7)),
    };
    const momentId = await createMoment("remember this");
    const result = await enrichMoment(
      db,
      { enricher: null, embedder: fakeEmbedder },
      momentId,
    );
    expect(result.embedded).toBe(true);
    const { rows } = await db.query(
      `SELECT model FROM embeddings WHERE owner_kind = 'moment' AND owner_id = $1`,
      [momentId],
    );
    expect(rows).toEqual([{ model: "fake-embed" }]);
  });

  it("marks failed with an error message and audit row", async () => {
    const momentId = await createMoment("save this");
    await markFailed(db, momentId, userId, "provider exploded");
    const { rows } = await db.query(
      "SELECT enrichment_status, enrichment_error FROM context_moments WHERE id = $1",
      [momentId],
    );
    expect(rows[0]).toEqual({
      enrichment_status: "failed",
      enrichment_error: "provider exploded",
    });
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE event_type = 'enrichment.failed' AND subject_id = $1`,
      [momentId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("retries through the queue and succeeds on a later attempt", async () => {
    const env = loadEnv({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl });
    const queue = new Queue(QUEUE, { connection: { url: redisUrl! } });
    await queue.obliterate({ force: true });

    let calls = 0;
    const flakyEmbedder: EmbeddingProvider = {
      name: "flaky",
      model: "flaky-embed",
      dimensions: 1536,
      embed: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient outage"));
        return Promise.resolve(new Array(1536).fill(0.1));
      },
    };
    const worker = startWorker({
      env,
      pool: db,
      deps: { enricher: null, embedder: flakyEmbedder },
      queueName: QUEUE,
    });
    await worker.waitUntilReady();

    const momentId = await createMoment("research retry behavior");
    const completed = new Promise<void>((resolve, reject) => {
      worker.on("completed", (job) => {
        if (job.data.momentId === momentId) resolve();
      });
      setTimeout(() => reject(new Error("timed out waiting for completion")), 20_000);
    });
    await queue.add(
      "enrich",
      { momentId, userId },
      { attempts: 3, backoff: { type: "fixed", delay: 100 } },
    );
    await completed;

    expect(calls).toBe(2); // failed once, succeeded on retry
    const { rows } = await db.query(
      "SELECT enrichment_status FROM context_moments WHERE id = $1",
      [momentId],
    );
    expect(rows[0].enrichment_status).toBe("completed");

    await worker.close();
    await queue.close();
  }, 30_000);

  it("marks failed only after the final attempt", async () => {
    const env = loadEnv({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl });
    const queue = new Queue(QUEUE, { connection: { url: redisUrl! } });

    const alwaysFailing: EmbeddingProvider = {
      name: "down",
      model: "down-embed",
      dimensions: 1536,
      embed: () => Promise.reject(new Error("permanent outage")),
    };
    const worker = startWorker({
      env,
      pool: db,
      deps: { enricher: null, embedder: alwaysFailing },
      queueName: QUEUE,
    });
    await worker.waitUntilReady();

    const momentId = await createMoment("this will fail");
    let failures = 0;
    const finalFailure = new Promise<void>((resolve, reject) => {
      worker.on("failed", (job) => {
        if (job?.data.momentId !== momentId) return;
        failures += 1;
        if ((job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1)) resolve();
      });
      setTimeout(() => reject(new Error("timed out waiting for final failure")), 20_000);
    });
    await queue.add(
      "enrich",
      { momentId, userId },
      { attempts: 2, backoff: { type: "fixed", delay: 100 } },
    );
    await finalFailure;
    expect(failures).toBe(2);

    // markFailed runs async off the event — poll briefly.
    let status = "";
    let error: string | null = null;
    for (let i = 0; i < 50; i++) {
      const { rows } = await db.query(
        "SELECT enrichment_status, enrichment_error FROM context_moments WHERE id = $1",
        [momentId],
      );
      status = rows[0].enrichment_status;
      error = rows[0].enrichment_error;
      if (status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("failed");
    expect(error).toContain("permanent outage");

    await worker.close();
    await queue.close();
  }, 30_000);
});
