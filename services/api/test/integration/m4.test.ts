import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";

/**
 * M4 integration tests: user-visible audit log, analytics allowlist +
 * off-switch + no-content guarantee, export filters, and project deletion.
 */
const databaseUrl = process.env.DATABASE_URL;

const SECRET_TEXT = "the xylophone launch plan is confidential";

describe.skipIf(!databaseUrl)("M4: audit, analytics, export filters, project delete", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let userId: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({ env: loadEnv({ DATABASE_URL: databaseUrl }), liveQa: null });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    userId = (await db.query("SELECT id FROM users WHERE email = 'dev@nova.local'"))
      .rows[0].id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  describe("audit log endpoint", () => {
    it("lists events with friendly labels and no captured content", async () => {
      const created = (
        await app.inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: {
            source_mode: "instant_capture",
            source_meta: { url: "https://audit.example.com/x", title: "Audit fixture" },
            payload: {},
            extracted_text: SECRET_TEXT,
            intent_text: `create a task about ${SECRET_TEXT}`,
          },
        })
      ).json();
      expect(created.id).toBeTruthy();

      const res = await app.inject({ method: "GET", url: "/v1/audit?limit=100" });
      expect(res.statusCode).toBe(200);
      const { items } = res.json();
      expect(items.length).toBeGreaterThan(0);
      const capture = items.find(
        (i: { subject_id: string }) => i.subject_id === created.id,
      );
      expect(capture.label).toBe("Context Moment captured");
      // The whole audit response never leaks captured content.
      expect(JSON.stringify(items)).not.toContain("xylophone");
    });

    it("filters by event type", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit?event_type=capture&limit=50",
      });
      const { items } = res.json();
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i: { event_type: string }) => i.event_type === "capture")).toBe(
        true,
      );
    });
  });

  describe("analytics events", () => {
    it("accepts allowlisted client events and audits live-session lifecycle", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: { event: "live_session_started", props: { mode: "text_only" } },
      });
      expect(res.statusCode).toBe(202);

      const stored = await db.query(
        `SELECT props FROM product_events
         WHERE user_id = $1 AND event = 'live_session_started'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      expect(stored.rows[0].props.mode).toBe("text_only");

      const audit = await db.query(
        `SELECT 1 FROM audit_log WHERE user_id = $1 AND event_type = 'live.session.start'`,
        [userId],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
    });

    it("rejects unknown events and content-sized props", async () => {
      const unknown = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: { event: "totally_made_up" },
      });
      expect(unknown.statusCode).toBe(400);

      const oversized = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: {
          event: "extension_opened",
          props: { leaked: SECRET_TEXT + SECRET_TEXT },
        },
      });
      expect(oversized.statusCode).toBe(400);
    });

    it("server-side funnel events fire without captured content", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: { query: "xylophone confidential launch" },
      });
      // Analytics is fire-and-forget — poll briefly for the row to land.
      let searchRows: { rows: Array<{ event: string; props: unknown }> } = { rows: [] };
      for (let i = 0; i < 30; i++) {
        searchRows = await db.query(
          `SELECT event, props FROM product_events
           WHERE user_id = $1 AND event = 'search_performed'`,
          [userId],
        );
        if (searchRows.rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(searchRows.rows.length).toBeGreaterThan(0);
      const saved = await db.query(
        `SELECT 1 FROM product_events WHERE user_id = $1 AND event = 'instant_capture_saved'`,
        [userId],
      );
      expect(saved.rows.length).toBeGreaterThan(0);
      // No captured content anywhere in analytics.
      expect(JSON.stringify(searchRows.rows)).not.toContain("xylophone");
    });

    it("NOVA_ANALYTICS=off stores nothing", async () => {
      const offApp = await buildApp({
        env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_ANALYTICS: "off" }),
        liveQa: null,
      });
      await offApp.ready();
      try {
        const before = (
          await db.query(`SELECT count(*)::int AS n FROM product_events WHERE user_id = $1`, [userId])
        ).rows[0].n;
        const res = await offApp.inject({
          method: "POST",
          url: "/v1/events",
          payload: { event: "extension_opened" },
        });
        expect(res.statusCode).toBe(202);
        // give the fire-and-forget a beat
        await new Promise((r) => setTimeout(r, 100));
        const after = (
          await db.query(`SELECT count(*)::int AS n FROM product_events WHERE user_id = $1`, [userId])
        ).rows[0].n;
        expect(after).toBe(before);
      } finally {
        await offApp.close();
      }
    });
  });

  describe("export filters", () => {
    let projectId: string;

    beforeAll(async () => {
      const { rows } = await db.query(
        `INSERT INTO projects (user_id, name) VALUES ($1, 'ExportScope') RETURNING id`,
        [userId],
      );
      projectId = rows[0].id;
      await app.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { url: "https://scope.example.com/in", title: "In scope" },
          payload: {},
          extracted_text: "scoped content",
          project_id: projectId,
        },
      });
    });

    it("exports by project", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/export?project_id=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.filters.project_id).toBe(projectId);
      expect(body.moments.length).toBe(1);
      expect(body.moments[0].source_meta.title).toBe("In scope");
    });

    it("exports by date range and audits the export", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/export?from=2000-01-01&to=2001-01-01`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().moments).toHaveLength(0);

      const audit = await db.query(
        `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'export'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      expect(audit.rows[0].detail.filtered).toBe(true);
    });
  });

  describe("project deletion", () => {
    it("deletes a project with its content, audited by counts only", async () => {
      const { rows } = await db.query(
        `INSERT INTO projects (user_id, name) VALUES ($1, 'DoomedProject') RETURNING id`,
        [userId],
      );
      const projectId = rows[0].id;
      const moment = (
        await app.inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: {
            source_mode: "instant_capture",
            source_meta: { url: "https://doomed.example.com/p", title: "Unique Walrus Page" },
            payload: {},
            extracted_text: "walrus content",
            intent_text: "create a task about the walrus",
            project_id: projectId,
          },
        })
      ).json();
      expect(moment.task).not.toBeNull();

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}?delete_moments=true`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ deleted: true, moments: 1 });
      expect(res.json().tasks).toBeGreaterThanOrEqual(1);

      const gone = await app.inject({
        method: "GET",
        url: `/v1/context/moments/${moment.id}`,
      });
      expect(gone.statusCode).toBe(404);

      const audit = await db.query(
        `SELECT detail FROM audit_log WHERE event_type = 'project.delete' AND subject_id = $1`,
        [projectId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].detail.content_deleted).toBe(true);
      expect(JSON.stringify(audit.rows[0].detail)).not.toContain("Walrus");
    });

    it("keeps content when delete_moments is false (unlink only)", async () => {
      const { rows } = await db.query(
        `INSERT INTO projects (user_id, name) VALUES ($1, 'ShellProject') RETURNING id`,
        [userId],
      );
      const projectId = rows[0].id;
      const moment = (
        await app.inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: {
            source_mode: "instant_capture",
            source_meta: { url: "https://keep.example.com/k", title: "Keep me" },
            payload: {},
            extracted_text: "keepable",
            project_id: projectId,
          },
        })
      ).json();

      const res = await app.inject({ method: "DELETE", url: `/v1/projects/${projectId}` });
      expect(res.json().moments).toBe(0);
      const kept = await app.inject({
        method: "GET",
        url: `/v1/context/moments/${moment.id}`,
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json().project_id).toBeNull(); // FK set-null
    });
  });
});
