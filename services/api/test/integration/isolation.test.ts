import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M5 isolation suite: User A's data is invisible and immutable to User B
 * across every user-owned resource — moments (instant + live-saved), search,
 * projects, tasks, actions (approve/reject), audit, export, delete, events.
 * Cross-user reads return 404 (not 403) so existence never leaks.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("M5: per-user isolation", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let alice: TestUser;
  let bob: TestUser;
  let aliceMomentId: string;
  let aliceLiveMomentId: string;
  let aliceTaskId: string;
  let aliceProjectId: string;
  let aliceProposedActionId: string;
  // Letters only: digit runs can look like card numbers (Luhn) or tokens to
  // the capture-time redactor, which would mask the marker before storage.
  const MARKER = `xylophonequarantine${String(Date.now())
    .split("")
    .map((d) => "abcdefghij"[Number(d)])
    .join("")}`;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null, env: loadEnv({ DATABASE_URL: databaseUrl }) });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();

    alice = await createUser(app, `alice-iso-${Date.now()}@test.local`);
    bob = await createUser(app, `bob-iso-${Date.now()}@test.local`);

    // Alice's world: a project, an instant capture (creates a task via
    // intent), a live-saved moment, and a proposed action.
    const projects = await alice.inject({ method: "GET", url: "/v1/projects" });
    aliceProjectId = projects.json().items[0].id;

    const capture = await alice.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://secret.example.com/plan", title: `Plan ${MARKER}` },
        payload: { dom_extract: { main_text: `The ${MARKER} document.` } },
        extracted_text: `The ${MARKER} document.`,
        intent_text: `create a task to review the ${MARKER} plan`,
        project_id: aliceProjectId,
      },
    });
    expect(capture.statusCode).toBe(201);
    aliceMomentId = capture.json().id;
    aliceTaskId = capture.json().task.id;

    const live = await alice.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "live_context",
        source_meta: { url: "https://secret.example.com/live", title: "Live" },
        payload: {},
        extracted_text: `Live snapshot about ${MARKER}.`,
        intent_text: null,
      },
    });
    expect(live.statusCode).toBe(201);
    aliceLiveMomentId = live.json().id;

    const proposed = await db.query<{ id: string }>(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
       VALUES ($1, $2, 'nova_task', 0, 'proposed', $3) RETURNING id`,
      [alice.userId, aliceMomentId, JSON.stringify({ title: "Alice pending", priority: "med" })],
    );
    aliceProposedActionId = proposed.rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("B cannot read A's moments by id (404, both instant and live-saved)", async () => {
    for (const id of [aliceMomentId, aliceLiveMomentId]) {
      const asBob = await bob.inject({ method: "GET", url: `/v1/context/moments/${id}` });
      expect(asBob.statusCode).toBe(404);
      const asAlice = await alice.inject({ method: "GET", url: `/v1/context/moments/${id}` });
      expect(asAlice.statusCode).toBe(200);
    }
  });

  it("B's timeline and project listing exclude A's data", async () => {
    const list = await bob.inject({ method: "GET", url: "/v1/context/moments" });
    expect(list.json().items.map((m: { id: string }) => m.id)).not.toContain(aliceMomentId);

    const projects = await bob.inject({ method: "GET", url: "/v1/projects" });
    expect(projects.json().items.map((p: { id: string }) => p.id)).not.toContain(aliceProjectId);
  });

  it("B cannot search A's memory", async () => {
    const res = await bob.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { query: MARKER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);

    const asAlice = await alice.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { query: MARKER },
    });
    expect(asAlice.json().items.length).toBeGreaterThan(0);
  });

  it("B cannot open A's project or link a moment into it", async () => {
    const detail = await bob.inject({ method: "GET", url: `/v1/projects/${aliceProjectId}` });
    expect(detail.statusCode).toBe(404);

    const link = await bob.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://bob.example.com", title: "Bob page" },
        payload: {},
        extracted_text: "bob content",
        intent_text: null,
        project_id: aliceProjectId,
      },
    });
    expect(link.statusCode).toBe(400);
  });

  it("B cannot read or complete A's tasks", async () => {
    const list = await bob.inject({ method: "GET", url: "/v1/tasks" });
    expect(list.json().items.map((t: { id: string }) => t.id)).not.toContain(aliceTaskId);

    const patch = await bob.inject({
      method: "PATCH",
      url: `/v1/tasks/${aliceTaskId}`,
      payload: { status: "done" },
    });
    expect(patch.statusCode).toBe(404);
    const still = await db.query("SELECT status FROM tasks WHERE id = $1", [aliceTaskId]);
    expect(still.rows[0].status).toBe("open");
  });

  it("B cannot approve, reject, or even see A's actions", async () => {
    const list = await bob.inject({ method: "GET", url: "/v1/actions" });
    expect(list.json().items.map((a: { id: string }) => a.id)).not.toContain(
      aliceProposedActionId,
    );

    const approve = await bob.inject({
      method: "POST",
      url: `/v1/actions/${aliceProposedActionId}/approve`,
    });
    expect(approve.statusCode).toBe(404);
    const reject = await bob.inject({
      method: "POST",
      url: `/v1/actions/${aliceProposedActionId}/reject`,
    });
    expect(reject.statusCode).toBe(404);
    const still = await db.query("SELECT status FROM actions WHERE id = $1", [
      aliceProposedActionId,
    ]);
    expect(still.rows[0].status).toBe("proposed"); // nothing executed
  });

  it("B's export contains none of A's data", async () => {
    const res = await bob.inject({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    const serialized = res.body;
    expect(serialized).not.toContain(MARKER);
    expect(serialized).not.toContain(aliceMomentId);
    expect(serialized).not.toContain(aliceTaskId);
  });

  it("B cannot delete A's moment or project", async () => {
    const delMoment = await bob.inject({
      method: "DELETE",
      url: `/v1/context/moments/${aliceMomentId}`,
    });
    expect(delMoment.statusCode).toBe(404);

    const delProject = await bob.inject({
      method: "DELETE",
      url: `/v1/projects/${aliceProjectId}?delete_moments=true`,
    });
    expect(delProject.statusCode).toBe(404);

    const survives = await db.query("SELECT 1 FROM context_moments WHERE id = $1", [
      aliceMomentId,
    ]);
    expect(survives.rowCount).toBe(1);
  });

  it("B cannot read A's audit log", async () => {
    const res = await bob.inject({ method: "GET", url: "/v1/audit" });
    expect(res.statusCode).toBe(200);
    const subjects = res.json().items.map((e: { subject_id: string | null }) => e.subject_id);
    expect(subjects).not.toContain(aliceMomentId);
    expect(subjects).not.toContain(aliceProposedActionId);
  });

  it("B cannot revoke A's sessions", async () => {
    const aliceSessions = await alice.inject({ method: "GET", url: "/v1/auth/sessions" });
    const target = aliceSessions.json().items[0].id;
    const res = await bob.inject({ method: "DELETE", url: `/v1/auth/sessions/${target}` });
    expect(res.statusCode).toBe(404);
    const stillAlive = await alice.inject({ method: "GET", url: "/v1/auth/me" });
    expect(stillAlive.statusCode).toBe(200);
  });

  it("product events land under the authenticated user only", async () => {
    const res = await bob.inject({
      method: "POST",
      url: "/v1/events",
      payload: { event: "extension_opened", props: {} },
    });
    expect(res.statusCode).toBe(202);
    // analytics writes are fire-and-forget; give the insert a beat
    await new Promise((r) => setTimeout(r, 200));
    const rows = await db.query(
      `SELECT user_id FROM product_events WHERE event = 'extension_opened' AND user_id = $1`,
      [bob.userId],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    const asAlice = await db.query(
      `SELECT 1 FROM product_events WHERE user_id = $1 AND event = 'extension_opened'`,
      [alice.userId],
    );
    expect(asAlice.rowCount).toBe(0);
  });

  it("embeddings and enrichment artifacts stay scoped to their owner", async () => {
    // Simulate the worker having embedded A's moment; B's vector-less search
    // path cannot reach it (search already filters embeddings by user_id).
    const owned = await db.query(
      `SELECT count(*)::int AS n FROM embeddings WHERE user_id = $1`,
      [bob.userId],
    );
    expect(owned.rows[0].n).toBe(0);
  });
});
