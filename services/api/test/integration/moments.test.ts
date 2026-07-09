import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";

/**
 * Integration tests for the ingestion path: POST a Context Moment against a
 * real Postgres (pgvector image), read it back via list and detail.
 * Requires DATABASE_URL (see infra/docker-compose.dev.yml); skipped otherwise
 * so unit-only environments stay green.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("ingestion path (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({ env: loadEnv({ DATABASE_URL: databaseUrl }) });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  const captureBody = {
    source_mode: "instant_capture",
    source_meta: {
      url: "https://example.com/pricing",
      title: "Pricing — Example",
      viewport: { w: 1440, h: 900 },
    },
    payload: {
      dom_extract: {
        main_text: "Enterprise plans start at $99 per month.",
        headings: ["Pricing", "Enterprise"],
      },
      screenshot_data_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    },
    extracted_text: "Pricing — Example. Enterprise plans start at $99 per month.",
    intent_text: "remember this for the pricing project",
  };

  it("stores a capture and returns 201 with the contract shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.project_id).toBeNull();
    expect(body.redaction_state).toBe("pending");
    expect(body.enrichment.status).toBe("skipped");
    expect(body.links.self).toBe(`/v1/context/moments/${body.id}`);
  });

  it("round-trips: stored moment is retrievable by id with full payload", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody,
      })
    ).json();

    const res = await app.inject({
      method: "GET",
      url: `/v1/context/moments/${created.id}`,
    });
    expect(res.statusCode).toBe(200);
    const moment = res.json();
    expect(moment.source_meta.title).toBe("Pricing — Example");
    expect(moment.payload.dom_extract.main_text).toContain("Enterprise plans");
    expect(moment.intent_text).toBe("remember this for the pricing project");
  });

  it("lists moments newest-first and includes the new capture", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody,
      })
    ).json();

    const res = await app.inject({ method: "GET", url: "/v1/context/moments" });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((m: { id: string }) => m.id)).toContain(created.id);
    const times = items.map((m: { captured_at: string }) =>
      Date.parse(m.captured_at),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("links a capture to a project when project_id is valid", async () => {
    const projects = (
      await app.inject({ method: "GET", url: "/v1/projects" })
    ).json();
    const inbox = projects.items.find(
      (p: { name: string }) => p.name === "Inbox",
    );
    expect(inbox).toBeDefined();

    const res = await app.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: { ...captureBody, project_id: inbox.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().project_id).toBe(inbox.id);
  });

  it("rejects an unknown project_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        ...captureBody,
        project_id: "00000000-0000-4000-8000-000000000000",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("project_id");
  });

  it("rejects an invalid body with field-level issues", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: { source_mode: "ambient_surveillance" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("404s on a foreign/unknown moment id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/context/moments/00000000-0000-4000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("writes a payload-free audit_log row for each capture", async () => {
    const pgMod = await import("pg");
    const client = new pgMod.default.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: captureBody,
        })
      ).json();
      const { rows } = await client.query(
        `SELECT event_type, detail FROM audit_log
         WHERE subject_id = $1 AND subject_kind = 'moment'`,
        [created.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe("capture");
      // Contract: no context payloads or extracted text in the audit trail.
      expect(JSON.stringify(rows[0].detail)).not.toContain("Enterprise plans");
      expect(rows[0].detail.url_host).toBe("example.com");
    } finally {
      await client.end();
    }
  });
});
