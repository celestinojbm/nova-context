import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";

/**
 * M2 integration tests: fast capture + queue handoff, hybrid search
 * (keyword leg + every filter), action approval transitions, and the
 * project detail endpoint. Vector-leg fusion is exercised in the worker
 * suite via stored embeddings; here the API runs without an OPENAI key so
 * search reports legs.vector = false.
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const QUEUE = "test-api-enrich";

describe.skipIf(!databaseUrl)("M2: capture queue, search, actions, projects", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let userId: string;
  let inboxId: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        ...(redisUrl ? { REDIS_URL: redisUrl, NOVA_ENRICHMENT_QUEUE: QUEUE } : {}),
      }),
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    userId = (await db.query("SELECT id FROM users WHERE email = 'dev@nova.local'"))
      .rows[0].id;
    const projects = (
      await app.inject({ method: "GET", url: "/v1/projects" })
    ).json();
    inboxId = projects.items.find((p: { name: string }) => p.name === "Inbox").id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  function captureBody(overrides: Record<string, unknown> = {}) {
    return {
      source_mode: "instant_capture",
      source_meta: {
        url: "https://quantum-widgets.example.org/whitepaper",
        title: "Quantum Widget Whitepaper",
      },
      payload: {},
      extracted_text:
        "Quantum widgets use entangled flux capacitors to reduce latency.",
      intent_text: "remember this quantum whitepaper",
      ...overrides,
    };
  }

  describe.skipIf(!redisUrl)("capture → queue handoff", () => {
    it("stores fast with status pending and enqueues an enrichment job", async () => {
      const queue = new Queue(QUEUE, { connection: { url: redisUrl! } });
      await queue.obliterate({ force: true });

      const started = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(),
      });
      const elapsed = Date.now() - started;
      expect(res.statusCode).toBe(201);
      // Fast path: no LLM in the request cycle (generous CI margin).
      expect(elapsed).toBeLessThan(1500);

      const body = res.json();
      expect(body.enrichment.status).toBe("queued");
      expect(body.enrichment.job_id).toBeTruthy();
      // Heuristic intent still parsed synchronously.
      expect(body.intent.parser).toBe("heuristic");

      const stored = await db.query(
        "SELECT enrichment_status FROM context_moments WHERE id = $1",
        [body.id],
      );
      expect(stored.rows[0].enrichment_status).toBe("pending");

      const job = await queue.getJob(body.enrichment.job_id);
      expect(job?.data).toEqual({ momentId: body.id, userId });
      await queue.obliterate({ force: true });
      await queue.close();
    });
  });

  describe("hybrid memory search", () => {
    let quantumId: string;

    beforeAll(async () => {
      quantumId = (
        await app.inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: captureBody({ project_id: inboxId }),
        })
      ).json().id;
      // A decoy on a different domain / action type / priority.
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody({
          source_meta: {
            url: "https://recipes.example.net/pasta",
            title: "Pasta Recipes",
          },
          extracted_text: "How to cook perfect pasta carbonara at home.",
          intent_text: "create a task to try this recipe ASAP, it's urgent",
        }),
      });
    });

    it("finds moments by keyword with fts ranking", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: { query: "quantum flux capacitors" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.legs).toEqual({ fts: true, vector: false });
      expect(body.items.length).toBeGreaterThan(0);
      // The database accumulates identical fixtures across local runs, so
      // assert membership + relevance rather than exact first place.
      expect(body.items.map((m: { id: string }) => m.id)).toContain(quantumId);
      expect(body.items[0].match).toBe("fts");
      expect(body.items[0].score).toBeGreaterThan(0);
      expect(body.items[0].extracted_text).toContain("uantum");
      expect(
        body.items.some((m: { source_meta: { url: string } }) =>
          m.source_meta.url.includes("recipes"),
        ),
      ).toBe(false);
    });

    it("filters by project", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: { query: "quantum", project_id: inboxId },
      });
      expect(res.json().items.map((m: { id: string }) => m.id)).toContain(quantumId);

      const none = await app.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: { query: "pasta carbonara", project_id: inboxId },
      });
      expect(none.json().items).toHaveLength(0);
    });

    it("filters by domain, action type, and priority without a query", async () => {
      const byDomain = (
        await app.inject({
          method: "POST",
          url: "/v1/memory/search",
          payload: { domain: "recipes.example.net" },
        })
      ).json();
      expect(byDomain.items.length).toBeGreaterThan(0);
      expect(byDomain.items[0].match).toBe("filter");
      expect(
        byDomain.items.every((m: { source_meta: { url: string } }) =>
          m.source_meta.url.includes("recipes.example.net"),
        ),
      ).toBe(true);

      const byAction = (
        await app.inject({
          method: "POST",
          url: "/v1/memory/search",
          payload: { action_type: "create_task", domain: "recipes.example.net" },
        })
      ).json();
      expect(byAction.items.length).toBeGreaterThan(0);

      const byPriority = (
        await app.inject({
          method: "POST",
          url: "/v1/memory/search",
          payload: { priority: "high", domain: "recipes.example.net" },
        })
      ).json();
      expect(byPriority.items.length).toBeGreaterThan(0);

      const noHighQuantum = (
        await app.inject({
          method: "POST",
          url: "/v1/memory/search",
          payload: { priority: "high", domain: "quantum-widgets.example.org" },
        })
      ).json();
      expect(noHighQuantum.items).toHaveLength(0);
    });

    it("filters by enrichment status", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: {
          enrichment_status: redisUrl ? "pending" : "skipped",
          domain: "quantum-widgets.example.org",
        },
      });
      expect(res.json().items.length).toBeGreaterThan(0);
    });

    it("rejects invalid filters", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: { action_type: "hack_the_planet" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("action approval queue", () => {
    async function proposeAction(
      actionType = "nova_task",
      payload: Record<string, unknown> = { title: "Review the whitepaper", priority: "normal" },
    ): Promise<string> {
      const { rows } = await db.query(
        `INSERT INTO actions (user_id, project_id, action_type, risk_tier, status, payload)
         VALUES ($1, $2, $3, $4, 'proposed', $5) RETURNING id`,
        [userId, inboxId, actionType, actionType === "nova_task" ? 0 : 1, JSON.stringify(payload)],
      );
      return rows[0].id;
    }

    it("lists proposed actions", async () => {
      const id = await proposeAction();
      const res = await app.inject({ method: "GET", url: "/v1/actions?status=proposed" });
      expect(res.json().items.map((a: { id: string }) => a.id)).toContain(id);
    });

    it("approve executes a nova_task: proposed → done, task created, audited", async () => {
      const id = await proposeAction();
      const res = await app.inject({ method: "POST", url: `/v1/actions/${id}/approve` });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("done");
      expect(res.json().result.task_id).toBeTruthy();

      const action = await db.query(
        "SELECT status, approved_by, approved_at FROM actions WHERE id = $1",
        [id],
      );
      expect(action.rows[0].status).toBe("done");
      expect(action.rows[0].approved_by).toBe(userId);
      expect(action.rows[0].approved_at).not.toBeNull();

      const task = await db.query("SELECT title FROM tasks WHERE action_id = $1", [id]);
      expect(task.rows[0].title).toBe("Review the whitepaper");

      const audit = await db.query(
        `SELECT event_type FROM audit_log WHERE subject_id = $1 ORDER BY created_at`,
        [id],
      );
      expect(audit.rows.map((r) => r.event_type)).toEqual([
        "action.approve",
        "action.execute",
      ]);
    });

    it("approving twice returns 409 (only proposed can be approved)", async () => {
      const id = await proposeAction();
      await app.inject({ method: "POST", url: `/v1/actions/${id}/approve` });
      const second = await app.inject({ method: "POST", url: `/v1/actions/${id}/approve` });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("invalid_state");
    });

    it("reject transitions proposed → rejected and blocks re-approval", async () => {
      const id = await proposeAction();
      const res = await app.inject({ method: "POST", url: `/v1/actions/${id}/reject` });
      expect(res.json().status).toBe("rejected");
      const approve = await app.inject({ method: "POST", url: `/v1/actions/${id}/approve` });
      expect(approve.statusCode).toBe(409);
    });

    it("notion_page approval fails cleanly while Notion is not connected", async () => {
      const id = await proposeAction("notion_page", { title: "Whitepaper notes" });
      const res = await app.inject({ method: "POST", url: `/v1/actions/${id}/approve` });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("failed");
      expect(res.json().result.error).toBe("notion_not_connected");
      const audit = await db.query(
        `SELECT 1 FROM audit_log WHERE subject_id = $1 AND event_type = 'action.execute.failed'`,
        [id],
      );
      expect(audit.rows).toHaveLength(1);
    });

    it("404s on foreign/unknown action ids", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/actions/00000000-0000-4000-8000-000000000000/approve",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("project detail", () => {
    it("returns moments, tasks, actions, domains, and activity", async () => {
      // Linked capture that also auto-creates a task.
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody({
          project_id: inboxId,
          intent_text: "create a task to summarize the quantum whitepaper",
        }),
      });

      const res = await app.inject({ method: "GET", url: `/v1/projects/${inboxId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.project.id).toBe(inboxId);
      expect(body.project.name).toBe("Inbox");
      expect(body.moments.length).toBeGreaterThan(0);
      expect(body.moments[0].enrichment_status).toBeDefined();
      expect(body.tasks.length).toBeGreaterThan(0);
      expect(body.actions.length).toBeGreaterThan(0);
      expect(
        body.domains.some(
          (d: { domain: string }) => d.domain === "quantum-widgets.example.org",
        ),
      ).toBe(true);
      expect(body.activity.length).toBeGreaterThan(0);
      const kinds = new Set(body.activity.map((e: { kind: string }) => e.kind));
      expect(kinds.has("moment")).toBe(true);
      expect(kinds.has("task")).toBe(true);
    });

    it("404s on an unknown project", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/projects/00000000-0000-4000-8000-000000000000",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
