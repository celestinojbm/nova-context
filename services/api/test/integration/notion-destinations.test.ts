import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import type { NotionApiClient } from "../../src/integrations/notion-api.js";
import type { NotionOAuthClient } from "../../src/integrations/notion-oauth.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M7 suite: Notion destination selector — per-user listing (via the user's
 * own token), default destination storage, preview integration, approval
 * override, and cross-user isolation.
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const QUEUE_NAME = `test-dest-queue-${Date.now()}`;

const TOKEN_BY_CODE: Record<string, string> = {
  "alice-code": "secret_alice_token_123456",
  "bob-code": "secret_bob_token_654321",
};

const fakeOauth: NotionOAuthClient = {
  authorizeUrl: (state) => `https://notion.test/authorize?state=${encodeURIComponent(state)}`,
  exchangeCode: async (code) => ({
    accessToken: TOKEN_BY_CODE[code] ?? "secret_unknown",
    workspaceName: code === "alice-code" ? "Alice WS" : "Bob WS",
    workspaceId: "ws",
    botId: "bot",
  }),
};

/** Destinations depend on WHOSE token arrives — proves per-user scoping. */
const fakeNotionApi: NotionApiClient & { calls: string[] } = {
  calls: [],
  async listDestinations(token: string) {
    this.calls.push(token);
    if (token === TOKEN_BY_CODE["alice-code"]) {
      return [
        { id: "a".repeat(32), type: "page_id" as const, title: "Alice Notes" },
        { id: "b".repeat(32), type: "database_id" as const, title: "Alice DB" },
      ];
    }
    return [{ id: "c".repeat(32), type: "page_id" as const, title: "Bob Board" }];
  },
};

describe.skipIf(!databaseUrl || !redisUrl)("M7: Notion destinations", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let alice: TestUser;
  let bob: TestUser;

  async function connect(user: TestUser, code: string): Promise<void> {
    const start = await user.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/start",
    });
    const state = new URL(start.json().authorize_url).searchParams.get("state")!;
    const res = await user.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code, state },
    });
    expect(res.statusCode).toBe(200);
  }

  async function proposeNotionAction(user: TestUser): Promise<string> {
    const capture = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://dest.example.com/x", title: "Dest Page" },
        payload: {},
        extracted_text: "destination test",
        intent_text: null,
      },
    });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
       VALUES ($1, $2, 'notion_page', 1, 'proposed', $3) RETURNING id`,
      [user.userId, capture.json().id, JSON.stringify({ title: "Dest test page" })],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_ACTION_QUEUE: QUEUE_NAME,
        NOVA_RATE_LIMIT_PREFIX: `test-rl-dest-${Date.now()}`,
      }),
      notionOauth: fakeOauth,
      notionApi: fakeNotionApi,
      ocr: null,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    alice = await createUser(app, `alice-dest-${Date.now()}@test.local`);
    bob = await createUser(app, `bob-dest-${Date.now()}@test.local`);
    await connect(alice, "alice-code");
    await connect(bob, "bob-code");
  });

  afterAll(async () => {
    const q = new Queue(QUEUE_NAME, { connection: { url: redisUrl! } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
    await app?.close();
    await db?.end();
  });

  it("lists destinations using the CALLER's own token (scoped per user)", async () => {
    const aliceList = await alice.inject({
      method: "GET",
      url: "/v1/integrations/notion/destinations",
    });
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json().items.map((d: { title: string }) => d.title)).toEqual([
      "Alice Notes",
      "Alice DB",
    ]);
    expect(aliceList.json().default).toBeNull();

    const bobList = await bob.inject({
      method: "GET",
      url: "/v1/integrations/notion/destinations",
    });
    expect(bobList.json().items.map((d: { title: string }) => d.title)).toEqual(["Bob Board"]);
    // Each request used that user's decrypted token, never the other's.
    expect(fakeNotionApi.calls).toContain(TOKEN_BY_CODE["alice-code"]);
    expect(fakeNotionApi.calls).toContain(TOKEN_BY_CODE["bob-code"]);
  });

  it("saves a per-user default; the other user's default is untouched", async () => {
    const dest = { id: "a".repeat(32), type: "page_id", title: "Alice Notes" };
    const put = await alice.inject({
      method: "PUT",
      url: "/v1/integrations/notion/destination",
      payload: { destination: dest },
    });
    expect(put.statusCode).toBe(200);

    const aliceList = await alice.inject({
      method: "GET",
      url: "/v1/integrations/notion/destinations",
    });
    expect(aliceList.json().default).toEqual(dest);
    const bobList = await bob.inject({
      method: "GET",
      url: "/v1/integrations/notion/destinations",
    });
    expect(bobList.json().default).toBeNull();

    // Audit records the title only.
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'notion.destination.set'`,
      [alice.userId],
    );
    expect(audit.rows[0].detail.destination_title).toBe("Alice Notes");
  });

  it("preview shows the saved destination and the redaction/privacy sections", async () => {
    const actionId = await proposeNotionAction(alice);
    const res = await alice.inject({ method: "GET", url: `/v1/actions/${actionId}/preview` });
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview.connection.destination).toEqual({
      id: "a".repeat(32),
      type: "page_id",
      title: "Alice Notes",
    });
    const sections = JSON.stringify(preview.sections);
    expect(sections).toContain("Privacy");
    expect(sections).toContain("Screenshots are not uploaded to Notion");
    expect(sections).toContain(actionId); // action audit reference
    expect(sections).not.toContain("data:image");
  });

  it("approval-time override lands on the action payload (preview == execution)", async () => {
    const actionId = await proposeNotionAction(alice);
    const override = { id: "b".repeat(32), type: "database_id", title: "Alice DB" };
    const res = await alice.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/approve`,
      payload: { destination: override },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
    const { rows } = await db.query("SELECT payload FROM actions WHERE id = $1", [actionId]);
    expect(rows[0].payload.destination).toEqual(override);
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'action.queued'`,
      [actionId],
    );
    expect(audit.rows[0].detail.destination_override).toBe("Alice DB");
  });

  it("rejects malformed overrides without state change", async () => {
    const actionId = await proposeNotionAction(alice);
    const res = await alice.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/approve`,
      payload: { destination: { id: "x", type: "weird", title: "" } },
    });
    expect(res.statusCode).toBe(400);
    const { rows } = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
    expect(rows[0].status).toBe("proposed");
  });

  it("B cannot read or set A's destinations (endpoints are self-scoped)", async () => {
    // The endpoints operate only on the caller's own connection; assert
    // Bob's writes cannot touch Alice's stored default.
    await bob.inject({
      method: "PUT",
      url: "/v1/integrations/notion/destination",
      payload: {
        destination: { id: "c".repeat(32), type: "page_id", title: "Bob Board" },
      },
    });
    const aliceMeta = await db.query(
      `SELECT meta FROM integration_connections WHERE user_id = $1 AND provider = 'notion'`,
      [alice.userId],
    );
    expect(aliceMeta.rows[0].meta.default_destination.title).toBe("Alice Notes");

    // A user without a connection gets a clean 409, no leakage.
    const noConn = await createUser(app, `noconn-dest-${Date.now()}@test.local`);
    const list = await noConn.inject({
      method: "GET",
      url: "/v1/integrations/notion/destinations",
    });
    expect(list.statusCode).toBe(409);
  });
});
