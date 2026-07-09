import type { LiveAnswerRequest, LiveAnswerResponse } from "@nova/schema";
import type { LiveQaProvider } from "@nova/model-router";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { loginAsDevUser, type AuthedInject } from "./helpers.js";

/**
 * M3 integration tests: capture-time redaction (storage, audit, enrichment
 * input, live Q&A input), grounded live Q&A with degradation, save-from-live,
 * export, and deletion.
 */
const databaseUrl = process.env.DATABASE_URL;

const SECRETS = {
  email: "leaky.ceo@secretcorp.example",
  card: "4111 1111 1111 1111",
  key: "sk-proj0123456789abcdefXYZ",
  ssn: "078-05-1120",
};

describe.skipIf(!databaseUrl)("M3: redaction, live Q&A, save-from-live, export/delete", () => {
  let db: pg.Client;
  let userId: string;
  let inject: AuthedInject;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    userId = (await db.query("SELECT id FROM users WHERE email = 'dev@nova.local'"))
      .rows[0].id;
  });

  afterAll(async () => {
    await db?.end();
  });

  async function makeApp(opts: {
    redaction?: "on" | "off";
    liveQa?: LiveQaProvider | null;
  }): Promise<FastifyInstance> {
    const app = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_REDACTION: opts.redaction ?? "on",
      }),
      liveQa: opts.liveQa ?? null,
    });
    await app.ready();
    const dev = await loginAsDevUser(app, databaseUrl!);
    inject = dev.inject;
    return app;
  }

  function secretCapture() {
    return {
      source_mode: "instant_capture",
      source_meta: {
        url: "https://internal.example.com/creds",
        title: `Contact ${SECRETS.email}`,
      },
      payload: {
        dom_extract: {
          main_text: `Email ${SECRETS.email}, card ${SECRETS.card}, key ${SECRETS.key}`,
          headings: [`SSN ${SECRETS.ssn}`],
        },
      },
      extracted_text: `Email ${SECRETS.email}, card ${SECRETS.card}, key ${SECRETS.key}, ssn ${SECRETS.ssn}`,
      intent_text: `remember to email ${SECRETS.email} about this`,
    };
  }

  describe("capture-time redaction", () => {
    it("keeps secrets out of stored payloads, extracted text, and intent", async () => {
      const app = await makeApp({ redaction: "on" });
      try {
        const res = await inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: secretCapture(),
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.redaction_state).toBe("applied");

        const { rows } = await db.query(
          `SELECT payload, extracted_text, intent_text, source_meta, tsv::text AS tsv
           FROM context_moments WHERE id = $1`,
          [body.id],
        );
        const stored = JSON.stringify(rows[0]);
        for (const secret of Object.values(SECRETS)) {
          expect(stored).not.toContain(secret);
        }
        expect(rows[0].extracted_text).toContain("[REDACTED:email]");
        expect(rows[0].extracted_text).toContain("[REDACTED:card]");
        expect(rows[0].extracted_text).toContain("[REDACTED:api_key]");
        expect(rows[0].extracted_text).toContain("[REDACTED:ssn]");
        // What enrichment will read (extracted_text/intent/payload) is what
        // is stored — proven clean above; the worker never sees the original.
      } finally {
        await app.close();
      }
    });

    it("keeps secrets out of the audit log and records redaction counts", async () => {
      const app = await makeApp({ redaction: "on" });
      try {
        const created = (
          await inject({
            method: "POST",
            url: "/v1/context/moments",
            payload: secretCapture(),
          })
        ).json();
        const audit = await db.query(
          `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'capture'`,
          [created.id],
        );
        const detail = JSON.stringify(audit.rows[0].detail);
        for (const secret of Object.values(SECRETS)) {
          expect(detail).not.toContain(secret);
        }
        expect(audit.rows[0].detail.redactions.email).toBeGreaterThanOrEqual(1);
      } finally {
        await app.close();
      }
    });

    it("NOVA_REDACTION=off stores verbatim with state 'skipped'", async () => {
      const app = await makeApp({ redaction: "off" });
      try {
        const created = (
          await inject({
            method: "POST",
            url: "/v1/context/moments",
            payload: secretCapture(),
          })
        ).json();
        expect(created.redaction_state).toBe("skipped");
        const { rows } = await db.query(
          "SELECT extracted_text FROM context_moments WHERE id = $1",
          [created.id],
        );
        expect(rows[0].extracted_text).toContain(SECRETS.email);
      } finally {
        await app.close();
      }
    });
  });

  describe("live Q&A", () => {
    it("returns 503 when no provider is configured", async () => {
      const app = await makeApp({ liveQa: null });
      try {
        const res = await inject({
          method: "POST",
          url: "/v1/live/answers",
          payload: { question: "what is this?", context: {} },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("live_qa_unavailable");
      } finally {
        await app.close();
      }
    });

    it("answers grounded questions and audits without content", async () => {
      let received: LiveAnswerRequest | null = null;
      const fake: LiveQaProvider = {
        name: "fake",
        model: "fake-live",
        answer: (req) => {
          received = req;
          return Promise.resolve({
            answer: "You are looking at a pricing page for Quantum Widgets.",
            grounding: "grounded",
            model: "fake-live",
          } satisfies LiveAnswerResponse);
        },
      };
      const app = await makeApp({ liveQa: fake });
      try {
        const res = await inject({
          method: "POST",
          url: "/v1/live/answers",
          payload: {
            question: "what page is this?",
            context: {
              url: "https://quantum.example.com/pricing",
              title: "Quantum Pricing",
              frames: ["data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
              text_snippets: [`Plans from $99. Contact ${SECRETS.email}`],
              recent_qa: [],
            },
          },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().grounding).toBe("grounded");

        // Redaction before the provider call: the fake never saw the secret.
        expect(JSON.stringify(received)).not.toContain(SECRETS.email);
        expect(received!.context.text_snippets[0]).toContain("[REDACTED:email]");

        // Audit has metadata only, no question/answer content.
        const audit = await db.query(
          `SELECT detail FROM audit_log WHERE event_type = 'live.qa'
           ORDER BY created_at DESC LIMIT 1`,
        );
        const detail = JSON.stringify(audit.rows[0].detail);
        expect(audit.rows[0].detail.frames).toBe(1);
        expect(detail).not.toContain("what page is this");
        expect(detail).not.toContain("Quantum Widgets");
      } finally {
        await app.close();
      }
    });

    it("passes through the provider's insufficient_context verdict", async () => {
      const fake: LiveQaProvider = {
        name: "fake",
        model: "fake-live",
        answer: () =>
          Promise.resolve({
            answer: "I can't tell from the current context — no frames or text were captured yet.",
            grounding: "insufficient_context",
            model: "fake-live",
          }),
      };
      const app = await makeApp({ liveQa: fake });
      try {
        const res = await inject({
          method: "POST",
          url: "/v1/live/answers",
          payload: { question: "what's the price of the enterprise tier?", context: {} },
        });
        expect(res.json().grounding).toBe("insufficient_context");
      } finally {
        await app.close();
      }
    });
  });

  describe("save-from-live", () => {
    it("stores a live_context moment with session metadata, ready for enrichment", async () => {
      const app = await makeApp({});
      try {
        const startedAt = new Date(Date.now() - 90_000).toISOString();
        const savedAt = new Date().toISOString();
        const res = await inject({
          method: "POST",
          url: "/v1/context/moments",
          payload: {
            source_mode: "live_context",
            source_meta: {
              url: "https://talks.example.com/scaling",
              title: "Scaling Postgres — conference talk",
            },
            payload: {
              dom_extract: { main_text: "Three bottlenecks: connections, vacuum, replication lag." },
              screenshot_data_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
              live_session: {
                started_at: startedAt,
                saved_at: savedAt,
                duration_ms: 90_000,
                frame_count: 7,
                qa: [
                  {
                    question: "what were the three bottlenecks?",
                    answer: "Connections, vacuum, replication lag.",
                    at: savedAt,
                  },
                ],
              },
            },
            extracted_text:
              "Scaling Postgres. Three bottlenecks: connections, vacuum, replication lag.",
            intent_text: "save this moment about the three bottlenecks",
          },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.intent.action_type).toBe("save_reference");

        const moment = (
          await inject({ method: "GET", url: `/v1/context/moments/${body.id}` })
        ).json();
        expect(moment.source_mode).toBe("live_context");
        expect(moment.payload.live_session.frame_count).toBe(7);
        expect(moment.payload.live_session.qa).toHaveLength(1);
        // Enters the normal M2 pipeline (no Redis in this app → skipped).
        expect(moment.enrichment_status).toBe("skipped");
      } finally {
        await app.close();
      }
    });
  });

  describe("export and delete", () => {
    it("exports moments with tasks and actions as JSON", async () => {
      const app = await makeApp({});
      try {
        const created = (
          await inject({
            method: "POST",
            url: "/v1/context/moments",
            payload: {
              source_mode: "instant_capture",
              source_meta: { url: "https://export.example.com/a", title: "Export me" },
              payload: {},
              extracted_text: "Exportable content",
              intent_text: "create a task to verify export",
            },
          })
        ).json();

        const res = await inject({ method: "GET", url: "/v1/export" });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-disposition"]).toContain("attachment");
        const body = res.json();
        expect(body.format_version).toBe(2); // M8: media rides along
        expect(body.moments.map((m: { id: string }) => m.id)).toContain(created.id);
        expect(body.tasks.some((t: { moment_id: string }) => t.moment_id === created.id)).toBe(true);
        expect(body.projects.length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    it("deletes a moment with its tasks, actions, and embeddings; audits without content", async () => {
      const app = await makeApp({});
      try {
        const created = (
          await inject({
            method: "POST",
            url: "/v1/context/moments",
            payload: {
              source_mode: "instant_capture",
              source_meta: { url: "https://doomed.example.com/x", title: "Doomed Unique Zebra" },
              payload: {},
              extracted_text: "Doomed unique zebra content",
              intent_text: "create a task to delete-test this",
            },
          })
        ).json();
        expect(created.task).not.toBeNull();
        // Give it an embedding + a proposed action to prove full cleanup.
        await db.query(
          `INSERT INTO embeddings (user_id, owner_kind, owner_id, model, embedding)
           VALUES ($1, 'moment', $2, 'test', $3::vector)`,
          [userId, created.id, `[${new Array(1536).fill(0.01).join(",")}]`],
        );
        await db.query(
          `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
           VALUES ($1, $2, 'nova_task', 0, 'proposed', '{"title":"orphan?"}')`,
          [userId, created.id],
        );

        const del = await inject({
          method: "DELETE",
          url: `/v1/context/moments/${created.id}`,
        });
        expect(del.statusCode).toBe(200);
        expect(del.json().deleted).toBe(true);
        expect(del.json().tasks).toBeGreaterThanOrEqual(1);
        expect(del.json().actions).toBeGreaterThanOrEqual(1);

        const gone = await inject({
          method: "GET",
          url: `/v1/context/moments/${created.id}`,
        });
        expect(gone.statusCode).toBe(404);
        for (const table of ["tasks", "actions", "embeddings"]) {
          const col = table === "embeddings" ? "owner_id" : "moment_id";
          const { rows } = await db.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`,
            [created.id],
          );
          expect(rows[0].n).toBe(0);
        }

        const audit = await db.query(
          `SELECT detail FROM audit_log WHERE event_type = 'moment.delete' AND subject_id = $1`,
          [created.id],
        );
        expect(audit.rows).toHaveLength(1);
        const detail = JSON.stringify(audit.rows[0].detail);
        expect(audit.rows[0].detail.url_host).toBe("doomed.example.com");
        expect(detail).not.toContain("Zebra");
        expect(detail).not.toContain("zebra");
      } finally {
        await app.close();
      }
    });

    it("delete 404s for unknown moments", async () => {
      const app = await makeApp({});
      try {
        const res = await inject({
          method: "DELETE",
          url: "/v1/context/moments/00000000-0000-4000-8000-000000000000",
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});
