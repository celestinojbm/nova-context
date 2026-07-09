import { type NotionPageContent } from "@nova/context-engine";
import { encryptSecret } from "@nova/context-engine/secret-box";
import { UnrecoverableError } from "bullmq";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  executeAction,
  markActionFailed,
  type ActionDeps,
} from "../../src/actions.js";
import {
  NotionTransientError,
  type CreatedNotionPage,
  type NotionClient,
  type NotionParent,
} from "../../src/notion-client.js";

/**
 * M6 action-execution suite: state transitions, idempotency (no duplicate
 * external objects on retry/redelivery), terminal vs transient failures,
 * revoked connections, user scoping, and audit hygiene — against real
 * Postgres, with a fake Notion API.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY = randomBytes(32);
const TOKEN = "secret_worker_notion_token_xyz";

class FakeNotion implements NotionClient {
  createCalls = 0;
  findCalls = 0;
  failCreatesRemaining = 0;
  parent: NotionParent | null = { type: "page_id", id: "parent-1", title: "Home" };
  lastContent: NotionPageContent | null = null;

  async findParent(token: string): Promise<NotionParent | null> {
    this.findCalls += 1;
    if (token !== TOKEN) throw new Error("wrong token reached the provider");
    return this.parent;
  }

  async createPage(
    token: string,
    _parent: NotionParent,
    content: NotionPageContent,
  ): Promise<CreatedNotionPage> {
    if (token !== TOKEN) throw new Error("wrong token reached the provider");
    if (this.failCreatesRemaining > 0) {
      this.failCreatesRemaining -= 1;
      throw new NotionTransientError("simulated 503");
    }
    this.createCalls += 1;
    this.lastContent = content;
    return { id: `page-${this.createCalls}`, url: "https://notion.test/page" };
  }
}

describe.skipIf(!databaseUrl)("M6: action execution worker", () => {
  let db: pg.Pool;
  let userId: string;
  let otherUserId: string;
  let momentId: string;

  async function makeAction(
    status = "queued",
    owner = userId,
    result: Record<string, unknown> | null = null,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload, result)
       VALUES ($1, $2, 'notion_page', 1, $3, $4, $5) RETURNING id`,
      [
        owner,
        owner === userId ? momentId : null,
        status,
        JSON.stringify({ title: "Worker test page", detail: "detail text" }),
        result ? JSON.stringify(result) : null,
      ],
    );
    return rows[0]!.id;
  }

  function deps(notion: FakeNotion, key: Buffer | null = KEY): ActionDeps {
    return { notion, encryptionKey: key };
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const u1 = await db.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`worker-m6-${Date.now()}@test.local`],
    );
    userId = u1.rows[0]!.id;
    const u2 = await db.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`worker-m6-other-${Date.now()}@test.local`],
    );
    otherUserId = u2.rows[0]!.id;

    const moment = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, source_mode, source_meta, payload, extracted_text, intent_text)
       VALUES ($1, 'instant_capture', $2, '{}', $3, $4) RETURNING id`,
      [
        userId,
        JSON.stringify({ url: "https://w.example.com/doc", title: "Worker Doc" }),
        "Captured body text for the excerpt.",
        "send this to notion",
      ],
    );
    momentId = moment.rows[0]!.id;

    await db.query(
      `INSERT INTO integration_connections (user_id, provider, external_account, token_ciphertext, status)
       VALUES ($1, 'notion', 'Worker WS', $2, 'active')`,
      [userId, encryptSecret(KEY, TOKEN)],
    );
  });

  afterAll(async () => {
    await db?.end();
  });

  it("executes a queued action: done + external id + audit chain, exactly one page", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction();
    const outcome = await executeAction(db, deps(notion), { actionId, userId });
    expect(outcome).toBe("done");
    expect(notion.createCalls).toBe(1);

    const { rows } = await db.query("SELECT status, result FROM actions WHERE id = $1", [
      actionId,
    ]);
    expect(rows[0].status).toBe("done");
    expect(rows[0].result.page_id).toBe("page-1");
    expect(rows[0].result.page_url).toBe("https://notion.test/page");

    // The page content came from the shared builder — source + instruction present.
    const sections = JSON.stringify(notion.lastContent);
    expect(sections).toContain("https://w.example.com/doc");
    expect(sections).toContain("send this to notion");

    const audit = await db.query(
      `SELECT event_type, detail FROM audit_log WHERE subject_id = $1 ORDER BY created_at ASC`,
      [actionId],
    );
    const events = audit.rows.map((r) => r.event_type);
    expect(events).toEqual(["action.executing", "action.execute"]);
    const executed = audit.rows.find((r) => r.event_type === "action.execute");
    expect(executed.detail.external_id).toBe("page-1");
    // No captured content and no token in the audit trail.
    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain("Captured body text");
    expect(serialized).not.toContain(TOKEN);
  });

  it("is idempotent on redelivery: a done action never re-creates the page", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction();
    await executeAction(db, deps(notion), { actionId, userId });
    const again = await executeAction(db, deps(notion), { actionId, userId });
    expect(again).toBe("done");
    expect(notion.createCalls).toBe(1);
  });

  it("recovers a crashed-after-create attempt without a duplicate page", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction("queued", userId, {
      provider: "notion",
      page_id: "page-from-crashed-attempt",
    });
    const outcome = await executeAction(db, deps(notion), { actionId, userId });
    expect(outcome).toBe("done");
    expect(notion.createCalls).toBe(0); // finalized, not re-created
    const { rows } = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
    expect(rows[0].status).toBe("done");
  });

  it("retries transient provider failures without duplicating the page", async () => {
    const notion = new FakeNotion();
    notion.failCreatesRemaining = 1;
    const actionId = await makeAction();

    await expect(
      executeAction(db, deps(notion), { actionId, userId }, 1),
    ).rejects.toThrow(NotionTransientError);
    // Still in-flight, not failed — the queue will retry.
    const mid = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
    expect(mid.rows[0].status).toBe("executing");
    expect(notion.createCalls).toBe(0);

    const outcome = await executeAction(db, deps(notion), { actionId, userId }, 2);
    expect(outcome).toBe("done");
    expect(notion.createCalls).toBe(1);
  });

  it("marks terminal failure after the final retry (markActionFailed)", async () => {
    const actionId = await makeAction();
    await db.query(`UPDATE actions SET status = 'executing' WHERE id = $1`, [actionId]);
    await markActionFailed(db, { actionId, userId }, "notion responded 503");
    const { rows } = await db.query("SELECT status, result FROM actions WHERE id = $1", [
      actionId,
    ]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].result.error).toBe("notion responded 503");
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE subject_id = $1 AND event_type = 'action.execute.failed'`,
      [actionId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("fails closed without a connection — no provider call", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction("queued", otherUserId);
    await expect(
      executeAction(db, deps(notion), { actionId, userId: otherUserId }),
    ).rejects.toThrow(UnrecoverableError);
    expect(notion.createCalls).toBe(0);
    expect(notion.findCalls).toBe(0);
    const { rows } = await db.query("SELECT status, result FROM actions WHERE id = $1", [
      actionId,
    ]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].result.error).toBe("notion_not_connected");
  });

  it("fails closed when the connection is revoked", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction();
    await db.query(
      `UPDATE integration_connections SET status = 'revoked' WHERE user_id = $1`,
      [userId],
    );
    try {
      await expect(
        executeAction(db, deps(notion), { actionId, userId }),
      ).rejects.toThrow(UnrecoverableError);
      expect(notion.createCalls).toBe(0);
      const { rows } = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
      expect(rows[0].status).toBe("failed");
    } finally {
      await db.query(
        `UPDATE integration_connections SET status = 'active' WHERE user_id = $1`,
        [userId],
      );
    }
  });

  it("fails closed without the encryption key", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction();
    await expect(
      executeAction(db, deps(notion, null), { actionId, userId }),
    ).rejects.toThrow(UnrecoverableError);
    expect(notion.createCalls).toBe(0);
    const { rows } = await db.query("SELECT result FROM actions WHERE id = $1", [actionId]);
    expect(rows[0].result.error).toBe("encryption_key_missing");
  });

  it("fails cleanly when no Notion page is shared with the integration", async () => {
    const notion = new FakeNotion();
    notion.parent = null;
    const actionId = await makeAction();
    await expect(
      executeAction(db, deps(notion), { actionId, userId }),
    ).rejects.toThrow(UnrecoverableError);
    const { rows } = await db.query("SELECT result FROM actions WHERE id = $1", [actionId]);
    expect(rows[0].result.error).toBe("no_accessible_notion_page");
  });

  it("cannot execute with a mismatched user (cross-user job is a no-op)", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction(); // owned by userId
    const outcome = await executeAction(db, deps(notion), {
      actionId,
      userId: otherUserId, // wrong owner
    });
    expect(outcome).toBe("skipped");
    expect(notion.createCalls).toBe(0);
    const { rows } = await db.query("SELECT status FROM actions WHERE id = $1", [actionId]);
    expect(rows[0].status).toBe("queued"); // untouched
  });

  it("skips actions that are not queued/executing (rejected stays rejected)", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction("rejected");
    const outcome = await executeAction(db, deps(notion), { actionId, userId });
    expect(outcome).toBe("skipped");
    expect(notion.createCalls).toBe(0);
  });
});
