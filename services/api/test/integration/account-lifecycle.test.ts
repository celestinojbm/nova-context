import { encryptSecret, parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { runMediaCleanup } from "../../src/media/cleanup.js";
import { FsObjectStore } from "../../src/media/object-store.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M10 suite: account data lifecycle. Full export (everything, no secrets),
 * full deletion (everything gone, tombstone survives, sessions dead,
 * blob-delete failures tombstone into the queue), strict user isolation,
 * and the enrichment version endpoints.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const KEY = parseEncryptionKey(KEY_HEX);
const PASSWORD = "integration-test-password";

class FlakyStore extends FsObjectStore {
  failDeletes = false;
  override async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("simulated store outage");
    return super.delete(key);
  }
}

class CleanOcr implements OcrEngine {
  readonly name = "clean";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 40, y1: 20 }] };
  }
}

describe.skipIf(!databaseUrl)("M10: account data lifecycle", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let fsRoot: string;
  let store: FlakyStore;

  async function seedAccount(user: TestUser): Promise<{ momentId: string; storageKey: string }> {
    const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
    const png = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
    const capture = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://life.example.com/doc", title: "Lifecycle Doc" },
        payload: { screenshot_data_url: png },
        extracted_text: "lifecycle fixture text",
        intent_text: "remember this",
      },
    });
    expect(capture.statusCode).toBe(201);
    const momentId = capture.json().id as string;
    // A project, a task, an action, a fake Notion connection, an enrichment
    // version — every kind of thing an account can own.
    await db.query(
      `INSERT INTO projects (user_id, name) VALUES ($1, 'Lifecycle Project')`,
      [user.userId],
    );
    await db.query(
      `INSERT INTO tasks (user_id, moment_id, title) VALUES ($1, $2, 'Lifecycle task')`,
      [user.userId, momentId],
    );
    await db.query(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
       VALUES ($1, $2, 'notion_page', 1, 'proposed', '{"title":"Lifecycle page"}')`,
      [user.userId, momentId],
    );
    await db.query(
      `INSERT INTO integration_connections (user_id, provider, external_account, token_ciphertext, status)
       VALUES ($1, 'notion', 'Lifecycle WS', $2, 'active')`,
      [user.userId, encryptSecret(KEY, "secret_lifecycle_token_abc")],
    );
    await db.query(
      `INSERT INTO enrichment_versions (moment_id, user_id, version, summary, enrichment, provider)
       VALUES ($1, $2, 1, 'v1 summary', '{"tags":["one"]}', 'local')`,
      [momentId, user.userId],
    );
    const media = await db.query<{ storage_key: string }>(
      `SELECT storage_key FROM moment_media WHERE moment_id = $1`,
      [momentId],
    );
    return { momentId, storageKey: media.rows[0]!.storage_key };
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-lifecycle-${Date.now()}`);
    store = new FlakyStore(fsRoot);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: new CleanOcr(),
      objectStore: store,
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("full account export carries everything the account owns — and no secrets", async () => {
    const user = await createUser(app, `export-${Date.now()}@test.local`);
    const { momentId } = await seedAccount(user);

    const res = await user.inject({ method: "GET", url: "/v1/export/account" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("nova-account-export");
    expect(body.user.email).toBe(user.email);
    expect(body.projects.map((p: { name: string }) => p.name)).toContain("Lifecycle Project");
    expect(body.moments.map((m: { id: string }) => m.id)).toContain(momentId);
    expect(body.tasks).toHaveLength(1);
    expect(body.actions).toHaveLength(1);
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0].provider).toBe("notion");
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.audit_log.length).toBeGreaterThan(0);
    expect(body.enrichment_versions).toHaveLength(1);
    // refs mode: media as authenticated URLs, not pixels.
    const moment = body.moments.find((m: { id: string }) => m.id === momentId);
    expect(moment.media).toHaveLength(1);
    expect(moment.media[0].url).toContain("/v1/media/");
    expect(JSON.stringify(moment.media)).not.toContain("data:image");

    // No token in ANY form: not the plaintext, not the ciphertext column.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret_lifecycle_token_abc");
    expect(raw).not.toContain("token_ciphertext");

    // full mode inlines redacted pixels.
    const full = await user.inject({
      method: "GET",
      url: "/v1/export/account?media=full",
    });
    const fullMoment = full
      .json()
      .moments.find((m: { id: string }) => m.id === momentId);
    expect(fullMoment.media[0].data_url).toContain("data:image/png;base64,");

    // The export itself is audited (scope: account).
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'export'
       ORDER BY created_at DESC LIMIT 1`,
      [user.userId],
    );
    expect(audit.rows[0].detail.scope).toBe("account");
  });

  it("deletion demands a web session, the password, and a typed confirmation", async () => {
    const user = await createUser(app, `confirm-${Date.now()}@test.local`);

    const noConfirm = await user.inject({
      method: "POST",
      url: "/v1/auth/account/delete",
      payload: { password: PASSWORD },
    });
    expect(noConfirm.statusCode).toBe(400);

    const wrongConfirm = await user.inject({
      method: "POST",
      url: "/v1/auth/account/delete",
      payload: { password: PASSWORD, confirm: "delete" },
    });
    expect(wrongConfirm.statusCode).toBe(400);

    const wrongPassword = await user.inject({
      method: "POST",
      url: "/v1/auth/account/delete",
      payload: { password: "not-the-password", confirm: "DELETE" },
    });
    expect(wrongPassword.statusCode).toBe(401);

    // Nothing was deleted by the failed attempts.
    const me = await user.inject({ method: "GET", url: "/v1/auth/me" });
    expect(me.statusCode).toBe(200);
  });

  it("deletes EVERYTHING, kills sessions, wipes tokens, and leaves only a content-free tombstone", async () => {
    const user = await createUser(app, `delete-${Date.now()}@test.local`);
    const { momentId, storageKey } = await seedAccount(user);
    await access(join(fsRoot, storageKey)); // blob exists before

    const res = await user.inject({
      method: "POST",
      url: "/v1/auth/account/delete",
      payload: { password: PASSWORD, confirm: "DELETE" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().media.deleted).toBe(1);

    // Sessions no longer resolve: future API use is an ordinary 401.
    const after = await user.inject({ method: "GET", url: "/v1/auth/me" });
    expect(after.statusCode).toBe(401);

    // Every row family is gone.
    for (const [table, column] of [
      ["users", "id"],
      ["context_moments", "user_id"],
      ["projects", "user_id"],
      ["tasks", "user_id"],
      ["actions", "user_id"],
      ["moment_media", "user_id"],
      ["sessions", "user_id"],
      ["integration_connections", "user_id"],
      ["audit_log", "user_id"],
      ["product_events", "user_id"],
      ["enrichment_versions", "user_id"],
    ] as const) {
      const rows = await db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [user.userId]);
      expect(rows.rows, table).toHaveLength(0);
    }
    // The blob is gone from object storage too.
    await expect(access(join(fsRoot, storageKey))).rejects.toThrow();

    // The tombstone: counts and an email hash — no content, no email.
    const tombstone = await db.query(
      `SELECT email_hash, detail FROM account_tombstones WHERE deleted_user_id = $1`,
      [user.userId],
    );
    expect(tombstone.rows).toHaveLength(1);
    expect(tombstone.rows[0].detail.moments).toBe(1);
    expect(tombstone.rows[0].detail.integrations).toBe(1);
    const raw = JSON.stringify(tombstone.rows[0]);
    expect(raw).not.toContain(user.email);
    expect(raw).not.toContain("lifecycle fixture text");
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain(momentId);
  });

  it("blob-store failure during deletion tombstones the keys and still deletes the account", async () => {
    const user = await createUser(app, `flaky-${Date.now()}@test.local`);
    const { storageKey } = await seedAccount(user);

    store.failDeletes = true;
    try {
      const res = await user.inject({
        method: "POST",
        url: "/v1/auth/account/delete",
        payload: { password: PASSWORD, confirm: "DELETE" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().media.deleted).toBe(0);
      expect(res.json().media.queued).toBe(2); // full + thumb
    } finally {
      store.failDeletes = false;
    }
    // The account is gone; the undeletable (encrypted) blobs are tracked in
    // the queue, which survives the account precisely for this case.
    const gone = await db.query(`SELECT 1 FROM users WHERE id = $1`, [user.userId]);
    expect(gone.rows).toHaveLength(0);
    const queued = await db.query(
      `SELECT storage_key FROM media_delete_queue WHERE user_id = $1`,
      [user.userId],
    );
    expect(queued.rows.map((r) => r.storage_key)).toContain(storageKey);
    await access(join(fsRoot, storageKey)); // still on disk, awaiting cleanup
    // Tombstone records what was queued.
    const tombstone = await db.query(
      `SELECT detail FROM account_tombstones WHERE deleted_user_id = $1`,
      [user.userId],
    );
    expect(tombstone.rows[0].detail.media_blobs_queued).toBe(2);

    // Recovery works even though the account no longer exists: cleanup
    // drains the tombstoned keys and the blobs finally disappear.
    const report = await runMediaCleanup(db, store, {
      deleteOrphans: true,
      minAgeMinutes: 9999,
    });
    expect(report.queueDeleted).toBeGreaterThanOrEqual(2);
    await expect(access(join(fsRoot, storageKey))).rejects.toThrow();
    const drained = await db.query(
      `SELECT 1 FROM media_delete_queue WHERE user_id = $1`,
      [user.userId],
    );
    expect(drained.rows).toHaveLength(0);
  });

  it("lifecycle endpoints are strictly self-scoped: A's actions never touch B", async () => {
    const alice = await createUser(app, `iso-a-${Date.now()}@test.local`);
    const bob = await createUser(app, `iso-b-${Date.now()}@test.local`);
    const bobSeed = await seedAccount(bob);

    // Alice's export contains none of Bob's data.
    const aliceExport = await alice.inject({ method: "GET", url: "/v1/export/account" });
    const raw = JSON.stringify(aliceExport.json());
    expect(raw).not.toContain(bobSeed.momentId);
    expect(raw).not.toContain(bob.email);

    // Alice deleting HER account leaves Bob fully intact.
    await alice.inject({
      method: "POST",
      url: "/v1/auth/account/delete",
      payload: { password: PASSWORD, confirm: "DELETE" },
    });
    const bobMe = await bob.inject({ method: "GET", url: "/v1/auth/me" });
    expect(bobMe.statusCode).toBe(200);
    const bobMoment = await db.query(`SELECT 1 FROM context_moments WHERE id = $1`, [
      bobSeed.momentId,
    ]);
    expect(bobMoment.rows).toHaveLength(1);
    await access(join(fsRoot, bobSeed.storageKey)); // Bob's blob untouched
  });

  it("extension sessions cannot delete the account (web only)", async () => {
    const user = await createUser(app, `ext-${Date.now()}@test.local`);
    // Mint an extension session via the pairing flow.
    const code = await user.inject({ method: "POST", url: "/v1/auth/pairing-codes" });
    const claim = await app.inject({
      method: "POST",
      url: "/v1/auth/pairing/claim",
      payload: { code: code.json().code },
    });
    expect(claim.statusCode).toBe(201);
    const extToken = claim.json().token as string;
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/account/delete",
      headers: { authorization: `Bearer ${extToken}` },
      payload: { password: PASSWORD, confirm: "DELETE" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("enrichment versions: list + select move the current pointer without losing history", async () => {
    const user = await createUser(app, `enrich-${Date.now()}@test.local`);
    const { momentId } = await seedAccount(user); // seeded version 1
    await db.query(
      `INSERT INTO enrichment_versions (moment_id, user_id, version, summary, enrichment, provider, model)
       VALUES ($1, $2, 2, 'v2 summary', '{"tags":["two"]}', 'llm', 'claude-test')`,
      [momentId, user.userId],
    );
    await db.query(
      `UPDATE context_moments SET summary = 'v2 summary', enrichment = '{"tags":["two"]}'
       WHERE id = $1`,
      [momentId],
    );

    const list = await user.inject({
      method: "GET",
      url: `/v1/context/moments/${momentId}/enrichment/versions`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().versions).toHaveLength(2);
    expect(list.json().versions[0].version).toBe(2);
    expect(list.json().current.summary).toBe("v2 summary");

    // Select v1 back: pointer moves, history stays.
    const select = await user.inject({
      method: "POST",
      url: `/v1/context/moments/${momentId}/enrichment/select`,
      payload: { version: 1 },
    });
    expect(select.statusCode).toBe(200);
    const moment = await db.query(`SELECT summary FROM context_moments WHERE id = $1`, [momentId]);
    expect(moment.rows[0].summary).toBe("v1 summary");
    const versions = await db.query(
      `SELECT count(*) AS n FROM enrichment_versions WHERE moment_id = $1`,
      [momentId],
    );
    expect(Number(versions.rows[0].n)).toBe(2);

    // Other users can neither list nor select.
    const stranger = await createUser(app, `enrich-b-${Date.now()}@test.local`);
    const foreignList = await stranger.inject({
      method: "GET",
      url: `/v1/context/moments/${momentId}/enrichment/versions`,
    });
    expect(foreignList.statusCode).toBe(404);
    const foreignSelect = await stranger.inject({
      method: "POST",
      url: `/v1/context/moments/${momentId}/enrichment/select`,
      payload: { version: 2 },
    });
    expect(foreignSelect.statusCode).toBe(404);
  });
});
