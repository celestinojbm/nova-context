import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";

/**
 * M1 integration tests: intent parsing on capture, Tier-0 task creation,
 * project suggestion, override logging, and transcription degradation.
 * The env passes NO provider keys, so intent parsing runs the deterministic
 * heuristic and transcription is unavailable — both paths under test.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("M1: intent, tasks, suggestions (integration)", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let inboxId: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl }),
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    const projects = (
      await app.inject({ method: "GET", url: "/v1/projects" })
    ).json();
    inboxId = projects.items.find((p: { name: string }) => p.name === "Inbox").id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  function captureBody(intentText: string | null, projectId?: string) {
    return {
      source_mode: "instant_capture",
      source_meta: {
        url: "https://competitor.example.com/pricing",
        title: "Competitor Pricing",
      },
      payload: { dom_extract: { main_text: "Plans start at $49." } },
      extracted_text: "Competitor Pricing. Plans start at $49.",
      intent_text: intentText,
      ...(projectId ? { project_id: projectId } : {}),
    };
  }

  it("parses intent at capture and stores it with the moment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(
        "create a task to compare this with our pricing, for the Inbox project",
      ),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.intent).toMatchObject({
      action_type: "create_task",
      project_hint: "Inbox",
      parser: "heuristic",
    });

    // Round-trip: intent_parsed persisted on the moment.
    const moment = (
      await app.inject({ method: "GET", url: `/v1/context/moments/${body.id}` })
    ).json();
    expect(moment.intent_parsed.action_type).toBe("create_task");
  });

  it("auto-executes a Tier-0 Nova task linked to the moment", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody("add a task to review this ASAP, it's urgent"),
      })
    ).json();
    expect(created.task).not.toBeNull();

    const tasks = (await app.inject({ method: "GET", url: "/v1/tasks" })).json();
    const task = tasks.items.find((t: { id: string }) => t.id === created.task.id);
    expect(task).toBeDefined();
    expect(task.moment_id).toBe(created.id);
    expect(task.priority).toBe("high");
    expect(task.status).toBe("open");
    expect(task.moment_title).toBe("Competitor Pricing");

    // The task traces to a completed Tier-0 actions row.
    const { rows } = await db.query(
      `SELECT action_type, risk_tier, status, result FROM actions
       WHERE moment_id = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: "nova_task",
      risk_tier: 0,
      status: "done",
    });
    expect(rows[0].result.task_id).toBe(created.task.id);
  });

  it("does not create a task for a save-only instruction (M0 path intact)", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody("remember this for later"),
      })
    ).json();
    expect(created.intent.action_type).toBe("save_reference");
    expect(created.task).toBeNull();
  });

  it("keeps the M0 contract for captures without any instruction", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(null),
      })
    ).json();
    expect(created.intent).toBeNull();
    expect(created.task).toBeNull();
    expect(created.redaction_state).toBe("pending");
  });

  it("suggests a project from the intent's project hint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects/suggest",
      payload: { intent_text: "save this for the Inbox project" },
    });
    expect(res.statusCode).toBe(200);
    const { suggestions } = res.json();
    expect(suggestions[0].id).toBe(inboxId);
    expect(suggestions[0].confidence).toBeGreaterThan(0.5);
  });

  it("suggests unlinked captures' projects in the create response", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody("save this for the Inbox project"),
      })
    ).json();
    expect(created.project_id).toBeNull();
    expect(created.suggested_projects[0].id).toBe(inboxId);
  });

  it("logs an override when the user picks against the top suggestion", async () => {
    // Second project so the user can contradict the Inbox suggestion.
    const { rows } = await db.query(
      `INSERT INTO projects (user_id, name)
       SELECT id, 'Skunkworks' FROM users WHERE email = 'dev@nova.local'
       ON CONFLICT DO NOTHING
       RETURNING id`,
    );
    const skunkworksId =
      rows[0]?.id ??
      (
        await db.query(
          `SELECT p.id FROM projects p JOIN users u ON u.id = p.user_id
           WHERE u.email = 'dev@nova.local' AND p.name = 'Skunkworks'`,
        )
      ).rows[0].id;

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        // Hint says Inbox; the user links Skunkworks → override.
        payload: captureBody("save this for the Inbox project", skunkworksId),
      })
    ).json();
    expect(created.project_id).toBe(skunkworksId);

    const audit = await db.query(
      `SELECT detail FROM audit_log
       WHERE event_type = 'project.link.override' AND subject_id = $1`,
      [created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({
      chosen_project_id: skunkworksId,
      suggested_project_id: inboxId,
    });
  });

  it("toggles a task done and back via PATCH", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody("create a task to file this"),
      })
    ).json();
    const done = await app.inject({
      method: "PATCH",
      url: `/v1/tasks/${created.task.id}`,
      payload: { status: "done" },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().completed_at).not.toBeNull();

    const reopened = await app.inject({
      method: "PATCH",
      url: `/v1/tasks/${created.task.id}`,
      payload: { status: "open" },
    });
    expect(reopened.json().completed_at).toBeNull();
  });

  it("returns 503 for transcription when no provider is configured", async () => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(2048)], { type: "audio/webm" }), "voice.webm");
    const res = await app.inject({
      method: "POST",
      url: "/v1/transcriptions",
      // @ts-expect-error fastify inject accepts FormData bodies at runtime
      payload: form,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("transcription_unavailable");
  });
});
