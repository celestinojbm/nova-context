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
  lastParent: NotionParent | null = null;
  /** M9: properties passed to createPage (undefined = title-only shape). */
  lastProperties: Record<string, unknown> | undefined;
  /** M9: live database schema returned to the worker's re-validation. */
  databaseProperties = new Map<string, string>([
    ["Name", "title"],
    ["Summary", "rich_text"],
    ["Link", "url"],
    ["Tags", "multi_select"],
    ["Priority", "select"],
    ["Captured", "date"],
    ["Ref", "rich_text"],
  ]);

  async findParent(token: string): Promise<NotionParent | null> {
    this.findCalls += 1;
    if (token !== TOKEN) throw new Error("wrong token reached the provider");
    return this.parent;
  }

  async getDatabaseProperties(token: string): Promise<Map<string, string>> {
    if (token !== TOKEN) throw new Error("wrong token reached the provider");
    return this.databaseProperties;
  }

  async createPage(
    token: string,
    parent: NotionParent,
    content: NotionPageContent,
    properties?: Record<string, unknown>,
  ): Promise<CreatedNotionPage> {
    if (token !== TOKEN) throw new Error("wrong token reached the provider");
    if (this.failCreatesRemaining > 0) {
      this.failCreatesRemaining -= 1;
      throw new NotionTransientError("simulated 503");
    }
    this.createCalls += 1;
    this.lastParent = parent;
    this.lastContent = content;
    this.lastProperties = properties;
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
    payloadExtra: Record<string, unknown> = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload, result)
       VALUES ($1, $2, 'notion_page', 1, $3, $4, $5) RETURNING id`,
      [
        owner,
        owner === userId ? momentId : null,
        status,
        JSON.stringify({ title: "Worker test page", detail: "detail text", ...payloadExtra }),
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

  it("M7: uses the owner's saved default destination as the parent", async () => {
    const notion = new FakeNotion();
    await db.query(
      `UPDATE integration_connections
       SET meta = jsonb_set(meta, '{default_destination}', $2::jsonb)
       WHERE user_id = $1 AND provider = 'notion'`,
      [userId, JSON.stringify({ id: "dest-default", type: "page_id", title: "My Notes" })],
    );
    try {
      const actionId = await makeAction();
      await executeAction(db, deps(notion), { actionId, userId });
      expect(notion.lastParent).toEqual({ type: "page_id", id: "dest-default", title: "My Notes" });
      expect(notion.findCalls).toBe(0); // no fallback search needed
      const audit = await db.query(
        `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'action.execute'`,
        [actionId],
      );
      expect(audit.rows[0].detail.destination_title).toBe("My Notes");
    } finally {
      await db.query(
        `UPDATE integration_connections SET meta = meta - 'default_destination' WHERE user_id = $1`,
        [userId],
      );
    }
  });

  it("M7: approval-time override beats the saved default; fallback is findParent", async () => {
    const notion = new FakeNotion();
    await db.query(
      `UPDATE integration_connections
       SET meta = jsonb_set(meta, '{default_destination}', $2::jsonb)
       WHERE user_id = $1 AND provider = 'notion'`,
      [userId, JSON.stringify({ id: "dest-default", type: "page_id", title: "My Notes" })],
    );
    try {
      const withOverride = await makeAction("queued", userId, null, {
        destination: { id: "dest-override", type: "database_id", title: "Chosen DB" },
      });
      await executeAction(db, deps(notion), { actionId: withOverride, userId });
      expect(notion.lastParent?.id).toBe("dest-override");
      expect(notion.lastParent?.type).toBe("database_id");
    } finally {
      await db.query(
        `UPDATE integration_connections SET meta = meta - 'default_destination' WHERE user_id = $1`,
        [userId],
      );
    }
    // Neither override nor default → most recently edited shared page.
    const plain = await makeAction();
    const notion2 = new FakeNotion();
    await executeAction(db, deps(notion2), { actionId: plain, userId });
    expect(notion2.findCalls).toBe(1);
    expect(notion2.lastParent?.id).toBe("parent-1");
  });

  it("M9: database destination with saved mapping creates the page with mapped properties", async () => {
    const notion = new FakeNotion();
    await db.query(
      `UPDATE integration_connections
       SET meta = jsonb_set(
             jsonb_set(meta, '{default_destination}',
               '{"id":"db-1","type":"database_id","title":"Mapped DB"}'::jsonb),
             '{destination_mapping}',
             '{"title":"Name","summary":"Summary","source_url":"Link","tags":"Tags","created":"Captured","moment_ref":"Ref"}'::jsonb)
       WHERE user_id = $1 AND provider = 'notion'`,
      [userId],
    );
    try {
      const actionId = await makeAction();
      const outcome = await executeAction(db, deps(notion), { actionId, userId });
      expect(outcome).toBe("done");
      expect(notion.lastParent?.type).toBe("database_id");
      const props = notion.lastProperties!;
      expect(props).toBeTruthy();
      // Title always present under the mapped property name.
      expect(props["Name"]).toEqual({
        title: [{ type: "text", text: { content: "Worker test page" } }],
      });
      expect(props["Link"]).toEqual({ url: "https://w.example.com/doc" });
      expect(props["Ref"]).toEqual({
        rich_text: [{ type: "text", text: { content: `Nova moment ${momentId}` } }],
      });
      expect(props["Captured"]).toBeTruthy();
      // No pixels, ever.
      expect(JSON.stringify(props)).not.toContain("data:image");
    } finally {
      await db.query(
        `UPDATE integration_connections
         SET meta = (meta - 'default_destination') - 'destination_mapping'
         WHERE user_id = $1`,
        [userId],
      );
    }
  });

  it("M9: a property renamed since save is dropped; the page still lands", async () => {
    const notion = new FakeNotion();
    notion.databaseProperties.delete("Tags"); // user renamed/deleted it in Notion
    await db.query(
      `UPDATE integration_connections
       SET meta = jsonb_set(
             jsonb_set(meta, '{default_destination}',
               '{"id":"db-1","type":"database_id","title":"Mapped DB"}'::jsonb),
             '{destination_mapping}',
             '{"title":"Name","tags":"Tags","summary":"Summary"}'::jsonb)
       WHERE user_id = $1 AND provider = 'notion'`,
      [userId],
    );
    try {
      const actionId = await makeAction();
      const outcome = await executeAction(db, deps(notion), { actionId, userId });
      expect(outcome).toBe("done");
      const props = notion.lastProperties!;
      expect(props["Name"]).toBeTruthy();
      expect(props["Summary"]).toBeTruthy();
      expect(props["Tags"]).toBeUndefined(); // dropped, not fatal
    } finally {
      await db.query(
        `UPDATE integration_connections
         SET meta = (meta - 'default_destination') - 'destination_mapping'
         WHERE user_id = $1`,
        [userId],
      );
    }
  });

  it("M9: page destinations (and unmapped databases) keep the title-only shape", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction(); // no destination → findParent page
    await executeAction(db, deps(notion), { actionId, userId });
    expect(notion.lastProperties).toBeUndefined();

    const unmappedDb = await makeAction("queued", userId, null, {
      destination: { id: "db-2", type: "database_id", title: "Unmapped DB" },
    });
    const notion2 = new FakeNotion();
    await executeAction(db, deps(notion2), { actionId: unmappedDb, userId });
    expect(notion2.lastParent?.type).toBe("database_id");
    expect(notion2.lastProperties).toBeUndefined();
  });

  it("M7: page content carries provenance + privacy note and never any image data", async () => {
    // Give the moment a (masked) screenshot: the page must still not carry pixels.
    await db.query(
      `UPDATE context_moments
       SET payload = jsonb_set(payload, '{screenshot_data_url}', to_jsonb('data:image/png;base64,AAAA'::text)),
           image_redaction = '{"state":"applied","masked":2,"tally":{"email":2}}'::jsonb
       WHERE id = $1`,
      [momentId],
    );
    const notion = new FakeNotion();
    const actionId = await makeAction();
    await executeAction(db, deps(notion), { actionId, userId });
    const serialized = JSON.stringify(notion.lastContent);
    expect(serialized).toContain("Privacy");
    expect(serialized).toContain("Image redaction: applied (2 region(s) masked)");
    expect(serialized).toContain("Screenshots are not uploaded to Notion");
    expect(serialized).toContain(actionId); // audit reference
    expect(serialized).toContain(momentId); // moment reference
    expect(serialized).toContain("Source");
    expect(serialized).not.toContain("data:image");
  });

  it("skips actions that are not queued/executing (rejected stays rejected)", async () => {
    const notion = new FakeNotion();
    const actionId = await makeAction("rejected");
    const outcome = await executeAction(db, deps(notion), { actionId, userId });
    expect(outcome).toBe("skipped");
    expect(notion.createCalls).toBe(0);
  });
});
