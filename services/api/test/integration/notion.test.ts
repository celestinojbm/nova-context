import { decryptSecret, parseEncryptionKey } from "@nova/context-engine/secret-box";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import type { NotionOAuthClient } from "../../src/integrations/notion-oauth.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M6 suite: Notion OAuth connect flow (state validation, encrypted token
 * storage, disconnect), approve→queue transition for external actions, the
 * pre-approval preview, and cross-user isolation of connections/actions.
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const ENCRYPTION_KEY_HEX = randomBytes(32).toString("hex");
const FAKE_TOKEN = "secret_fake_notion_token_abc123";
const QUEUE_NAME = `test-action-queue-${Date.now()}`;

function fakeOauth(): NotionOAuthClient & { exchanged: string[] } {
  const exchanged: string[] = [];
  return {
    exchanged,
    authorizeUrl: (state: string) =>
      `https://notion.test/authorize?client_id=x&state=${encodeURIComponent(state)}`,
    exchangeCode: async (code: string) => {
      if (code === "bad-code") throw new Error("provider says no");
      exchanged.push(code);
      return {
        accessToken: FAKE_TOKEN,
        workspaceName: "Test Workspace",
        workspaceId: "ws-1",
        botId: "bot-1",
      };
    },
  };
}

describe.skipIf(!databaseUrl || !redisUrl)("M6: Notion OAuth + queued actions", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let alice: TestUser;
  let bob: TestUser;
  let oauth: ReturnType<typeof fakeOauth>;

  async function startState(user: TestUser): Promise<string> {
    const res = await user.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/start",
    });
    expect(res.statusCode).toBe(201);
    const url = new URL(res.json().authorize_url);
    return url.searchParams.get("state")!;
  }

  async function connect(user: TestUser): Promise<void> {
    const state = await startState(user);
    const res = await user.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "good-code", state },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, workspace: "Test Workspace" });
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    oauth = fakeOauth();
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        NOVA_ENCRYPTION_KEY: ENCRYPTION_KEY_HEX,
        NOVA_ACTION_QUEUE: QUEUE_NAME,
      }),
      notionOauth: oauth,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    alice = await createUser(app, `alice-m6-${Date.now()}@test.local`);
    bob = await createUser(app, `bob-m6-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    const q = new Queue(QUEUE_NAME, { connection: { url: redisUrl! } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
    await app?.close();
    await db?.end();
  });

  async function proposeNotionAction(user: TestUser): Promise<string> {
    const capture = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://research.example.com/paper", title: "A Paper" },
        payload: {},
        extracted_text: "Findings worth keeping.",
        intent_text: "remember this paper",
      },
    });
    const momentId = capture.json().id;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
       VALUES ($1, $2, 'notion_page', 1, 'proposed', $3) RETURNING id`,
      [user.userId, momentId, JSON.stringify({ title: "Save paper to Notion", detail: "Key findings" })],
    );
    return rows[0]!.id;
  }

  it("rejects the OAuth surface without configuration (fail closed)", async () => {
    const bare = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl }),
    });
    await bare.ready();
    try {
      const user = await createUser(bare, `noconf-${Date.now()}@test.local`);
      const res = await user.inject({
        method: "POST",
        url: "/v1/integrations/notion/oauth/start",
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("notion_not_configured");
    } finally {
      await bare.close();
    }
  });

  it("approving a notion action without a connection is a clear 409, no state change", async () => {
    const actionId = await proposeNotionAction(alice);
    const res = await alice.inject({ method: "POST", url: `/v1/actions/${actionId}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("notion_not_connected");
    const status = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
    expect(status.rows[0].status).toBe("proposed");
  });

  it("connects via OAuth and stores the token ONLY encrypted", async () => {
    await connect(alice);

    const list = await alice.inject({ method: "GET", url: "/v1/integrations" });
    expect(list.json().items).toEqual([
      expect.objectContaining({
        provider: "notion",
        status: "active",
        external_account: "Test Workspace",
      }),
    ]);

    const { rows } = await db.query<{ token_ciphertext: Buffer }>(
      `SELECT token_ciphertext FROM integration_connections
       WHERE user_id = $1 AND provider = 'notion'`,
      [alice.userId],
    );
    const stored = rows[0]!.token_ciphertext;
    expect(stored.toString("utf8")).not.toContain(FAKE_TOKEN);
    expect(stored.toString("latin1")).not.toContain(FAKE_TOKEN);
    expect(decryptSecret(parseEncryptionKey(ENCRYPTION_KEY_HEX), stored)).toBe(FAKE_TOKEN);

    // Audit: started + completed, workspace name only, never the token.
    const audit = await db.query(
      `SELECT event_type, detail FROM audit_log
       WHERE user_id = $1 AND event_type LIKE 'notion.%' ORDER BY created_at ASC`,
      [alice.userId],
    );
    const events = audit.rows.map((r) => r.event_type);
    expect(events).toContain("notion.connect.start");
    expect(events).toContain("notion.connect.completed");
    expect(JSON.stringify(audit.rows)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(audit.rows)).not.toContain("good-code");
  });

  it("rejects unknown, replayed, expired, and cross-user states", async () => {
    // Unknown state.
    const unknown = await alice.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "good-code", state: "f".repeat(43) },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("invalid_state");

    // Replay: a state works exactly once.
    const state = await startState(alice);
    const first = await alice.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "good-code", state },
    });
    expect(first.statusCode).toBe(200);
    const replay = await alice.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "good-code", state },
    });
    expect(replay.statusCode).toBe(400);

    // Expired.
    const expired = await startState(alice);
    await db.query(
      `UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`,
      [alice.userId],
    );
    const late = await alice.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "good-code", state: expired },
    });
    expect(late.statusCode).toBe(400);

    // Cross-user: Bob cannot complete a flow Alice started.
    const alicesState = await startState(alice);
    const hijack = await bob.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "good-code", state: alicesState },
    });
    expect(hijack.statusCode).toBe(400);
  });

  it("surfaces provider exchange failures without creating a connection", async () => {
    const state = await startState(bob);
    const res = await bob.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "bad-code", state },
    });
    expect(res.statusCode).toBe(502);
    const conn = await db.query(
      `SELECT 1 FROM integration_connections WHERE user_id = $1 AND provider = 'notion'`,
      [bob.userId],
    );
    expect(conn.rowCount).toBe(0);
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE user_id = $1 AND event_type = 'notion.connect.failed'`,
      [bob.userId],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("extension sessions cannot start OAuth flows", async () => {
    const minted = await alice.inject({ method: "POST", url: "/v1/auth/pairing-codes" });
    const claim = await app.inject({
      method: "POST",
      url: "/v1/auth/pairing/claim",
      payload: { code: minted.json().code },
    });
    const extToken = claim.json().token;
    const res = await app.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/start",
      headers: { authorization: `Bearer ${extToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("shows the exact pre-approval preview, including destination and content", async () => {
    const actionId = await proposeNotionAction(alice);
    const res = await alice.inject({ method: "GET", url: `/v1/actions/${actionId}/preview` });
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview.connection).toEqual({
      connected: true,
      provider: "notion",
      workspace: "Test Workspace",
    });
    expect(preview.title).toBe("Save paper to Notion");
    expect(preview.source_host).toBe("research.example.com");
    expect(preview.instruction).toBe("remember this paper");
    expect(preview.moment.id).toBeTruthy();
    const sectionText = JSON.stringify(preview.sections);
    expect(sectionText).toContain("Findings worth keeping.");
    expect(sectionText).toContain("https://research.example.com/paper");
  });

  it("approve queues the external action (no inline execution) with an idempotent job", async () => {
    const actionId = await proposeNotionAction(alice);
    const res = await alice.inject({ method: "POST", url: `/v1/actions/${actionId}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: actionId, status: "queued" });

    const status = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
    expect(status.rows[0].status).toBe("queued");

    const q = new Queue(QUEUE_NAME, { connection: { url: redisUrl! } });
    try {
      const job = await q.getJob(actionId);
      expect(job?.data).toEqual({ actionId, userId: alice.userId });
    } finally {
      await q.close();
    }

    // Audited approve + queued; double approval is rejected.
    const audit = await db.query(
      `SELECT event_type FROM audit_log WHERE subject_id = $1 ORDER BY created_at ASC`,
      [actionId],
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(["action.approve", "action.queued"]),
    );
    const again = await alice.inject({ method: "POST", url: `/v1/actions/${actionId}/approve` });
    expect(again.statusCode).toBe(409);
    expect(again.json().status).toBe("queued");
  });

  it("isolation: B cannot see, preview, or approve A's Notion world", async () => {
    // B sees only B's connections (none active — B's exchange failed above).
    const list = await bob.inject({ method: "GET", url: "/v1/integrations" });
    expect(
      list.json().items.filter((i: { status: string }) => i.status === "active"),
    ).toHaveLength(0);

    const actionId = await proposeNotionAction(alice);
    const preview = await bob.inject({ method: "GET", url: `/v1/actions/${actionId}/preview` });
    expect(preview.statusCode).toBe(404);
    const approve = await bob.inject({ method: "POST", url: `/v1/actions/${actionId}/approve` });
    expect(approve.statusCode).toBe(404);

    // B cannot disconnect A's connection (no own active row → 404, A's stays).
    const disconnect = await bob.inject({ method: "DELETE", url: "/v1/integrations/notion" });
    expect(disconnect.statusCode).toBe(404);
    const still = await db.query(
      `SELECT status FROM integration_connections WHERE user_id = $1 AND provider = 'notion'`,
      [alice.userId],
    );
    expect(still.rows[0].status).toBe("active");
  });

  it("disconnect revokes, wipes the ciphertext, and blocks further approvals", async () => {
    const res = await alice.inject({ method: "DELETE", url: "/v1/integrations/notion" });
    expect(res.statusCode).toBe(200);

    const { rows } = await db.query<{ status: string; token_ciphertext: Buffer }>(
      `SELECT status, token_ciphertext FROM integration_connections
       WHERE user_id = $1 AND provider = 'notion'`,
      [alice.userId],
    );
    expect(rows[0]!.status).toBe("revoked");
    expect(rows[0]!.token_ciphertext.length).toBe(0);

    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE user_id = $1 AND event_type = 'notion.disconnect'`,
      [alice.userId],
    );
    expect(audit.rowCount).toBe(1);

    const actionId = await proposeNotionAction(alice);
    const approve = await alice.inject({ method: "POST", url: `/v1/actions/${actionId}/approve` });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe("notion_not_connected");
  });
});
