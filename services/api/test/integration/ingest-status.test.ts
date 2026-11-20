import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, loginAsDevUser, type AuthedInject } from "./helpers.js";

/** Visible ingest status: pending+reason, failed+code/message, expired; filter by project. */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("GET /v1/context/ingest-status", () => {
  let app: FastifyInstance;
  let inject: AuthedInject;
  let db: pg.Client;
  let userId: string;
  let inboxId: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_RATE_LIMIT_PREFIX: `test-ingest-${Date.now()}`,
      }),
    });
    await app.ready();
    const dev = await loginAsDevUser(app, databaseUrl!);
    inject = dev.inject;
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    userId = (await db.query("SELECT id FROM users WHERE email = 'dev@nova.local'")).rows[0].id;
    const projects = (await inject({ method: "GET", url: "/v1/projects" })).json();
    inboxId = projects.items.find((p: { name: string }) => p.name === "Inbox").id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  async function insertMoment(overrides: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO context_moments
         (user_id, project_id, source_mode, source_meta, payload, extracted_text,
          enrichment_status, enrichment_wait_reason, enrichment_error_code, enrichment_error,
          enrichment_expires_at, captured_at)
       VALUES ($1, $2, 'instant_capture', '{}', '{}', 'texto de prueba',
               $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        overrides.user_id ?? userId,
        overrides.project_id ?? inboxId,
        overrides.enrichment_status ?? "pending",
        overrides.enrichment_wait_reason ?? "queued",
        overrides.enrichment_error_code ?? null,
        overrides.enrichment_error ?? null,
        overrides.enrichment_expires_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        overrides.captured_at ?? new Date(),
      ],
    );
    return rows[0].id as string;
  }

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/context/ingest-status" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid project_id", async () => {
    const res = await inject({ method: "GET", url: "/v1/context/ingest-status?project_id=no-uuid" });
    expect(res.statusCode).toBe(400);
  });

  it("returns pending with wait_reason and expires_at", async () => {
    const id = await insertMoment();
    const res = await inject({ method: "GET", url: "/v1/context/ingest-status?status=pending" });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { moment_id: string }) => i.moment_id === id);
    expect(item).toMatchObject({
      moment_id: id,
      project_id: inboxId,
      status: "pending",
      wait_reason: "queued",
      error_code: null,
      error_message: null,
    });
    expect(item.expires_at).toBeTruthy();
    await db.query("DELETE FROM context_moments WHERE id = $1", [id]);
  });

  it("returns failed with code and message", async () => {
    const id = await insertMoment({
      enrichment_status: "failed",
      enrichment_wait_reason: null,
      enrichment_error_code: "enrichment_failed",
      enrichment_error: "provider exploded",
    });
    const res = await inject({ method: "GET", url: "/v1/context/ingest-status?status=failed" });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { moment_id: string }) => i.moment_id === id);
    expect(item).toMatchObject({
      status: "failed",
      error_code: "enrichment_failed",
      error_message: "provider exploded",
      wait_reason: null,
    });
    await db.query("DELETE FROM context_moments WHERE id = $1", [id]);
  });

  it("returns expired when the TTL has passed, without rewriting the stored status", async () => {
    const id = await insertMoment({
      enrichment_status: "pending",
      enrichment_expires_at: new Date("2020-01-01T00:00:00Z"),
      captured_at: new Date("2020-01-01T00:00:00Z"),
    });
    const res = await inject({ method: "GET", url: "/v1/context/ingest-status?status=expired" });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { moment_id: string }) => i.moment_id === id);
    expect(item).toMatchObject({ status: "expired", wait_reason: "queued" });
    const stored = await db.query("SELECT enrichment_status FROM context_moments WHERE id = $1", [id]);
    expect(stored.rows[0].enrichment_status).toBe("pending");
    await db.query("DELETE FROM context_moments WHERE id = $1", [id]);
  });

  it("filters by project_id and hides other users' moments", async () => {
    const other = await createUser(app, `ingest-${Date.now()}@example.com`);
    const otherId = await insertMoment({ user_id: other.userId });
    const mine = await insertMoment({ project_id: inboxId });
    const otherProject = (
      await db.query(
        `INSERT INTO projects (user_id, name) VALUES ($1, 'Otro') RETURNING id`,
        [userId],
      )
    ).rows[0].id as string;
    const otherProjectMoment = await insertMoment({ project_id: otherProject });

    const res = await inject({ method: "GET", url: `/v1/context/ingest-status?project_id=${inboxId}` });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((i: { moment_id: string }) => i.moment_id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(otherProjectMoment);
    expect(ids).not.toContain(otherId);

    await db.query("DELETE FROM context_moments WHERE id = ANY($1)", [[mine, otherId, otherProjectMoment]]);
    await db.query("DELETE FROM projects WHERE id = $1", [otherProject]);
  });

  it("omits completed moments", async () => {
    const id = await insertMoment({ enrichment_status: "completed", enrichment_wait_reason: null });
    const res = await inject({ method: "GET", url: "/v1/context/ingest-status" });
    const ids = res.json().items.map((i: { moment_id: string }) => i.moment_id);
    expect(ids).not.toContain(id);
    await db.query("DELETE FROM context_moments WHERE id = $1", [id]);
  });
});
