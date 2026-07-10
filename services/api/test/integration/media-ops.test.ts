import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes } from "node:crypto";
import { access, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { runMediaCleanup } from "../../src/media/cleanup.js";
import { MediaService } from "../../src/media/media-service.js";
import { FsObjectStore } from "../../src/media/object-store.js";
import { parseEncryptionKey } from "@nova/context-engine/secret-box";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M9 suite: Media Reliability + Storage Operations — tombstoned (retryable)
 * blob deletes, orphan cleanup with dry-run + age guard, per-user storage
 * accounting with strict isolation, the adapter media-access guard, and the
 * optional media-view audit.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const KEY = parseEncryptionKey(KEY_HEX);

/** FsObjectStore whose deletes can be made to fail (partial-failure cases). */
class FlakyStore extends FsObjectStore {
  failDeletes = false;
  deleteAttempts = 0;
  override async delete(key: string): Promise<void> {
    this.deleteAttempts += 1;
    if (this.failDeletes) throw new Error("simulated store outage");
    return super.delete(key);
  }
}

class FakeOcr implements OcrEngine {
  readonly name = "fake";
  mode: "clean" | "fail" = "clean";
  async recognize(): Promise<{ words: OcrWord[] }> {
    if (this.mode === "fail") throw new Error("simulated ocr crash");
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 50, y1: 20 }] };
  }
}

async function whitePng(w = 400, h = 120): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}

describe.skipIf(!databaseUrl)("M9: media reliability + storage operations", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let user: TestUser;
  let fsRoot: string;
  let store: FlakyStore;
  const ocr = new FakeOcr();

  async function capture(u: TestUser, withImage = true): Promise<{ id: string; media: Array<{ id: string; url: string }> }> {
    ocr.mode = "clean";
    const res = await u.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://ops.example.com/page", title: "Ops Page" },
        payload: withImage ? { screenshot_data_url: await whitePng() } : {},
        extracted_text: "media ops test",
        intent_text: null,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-media-ops-${Date.now()}`);
    store = new FlakyStore(fsRoot);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr,
      objectStore: store,
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    user = await createUser(app, `media-ops-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("accounts per-user storage: objects, encrypted bytes, thumbnails, kinds, states", async () => {
    await capture(user);
    await capture(user);
    await capture(user, false); // no media

    const res = await user.inject({ method: "GET", url: "/v1/media/usage" });
    expect(res.statusCode).toBe(200);
    const usage = res.json();
    expect(usage.objects).toBe(2);
    expect(usage.total_bytes).toBeGreaterThan(0);
    expect(usage.thumbnail_bytes).toBeGreaterThan(0); // 400px wide → thumb exists
    expect(usage.by_kind.screenshot.objects).toBe(2);
    expect(usage.by_redaction_state.applied).toBe(2);
    expect(usage.by_project).toHaveLength(1); // unassigned bucket
    expect(usage.by_project[0].project_id).toBeNull();
    expect(usage.pending_deletions).toBe(0);
    // Aggregates only — nothing that looks like a key or content.
    expect(JSON.stringify(usage)).not.toContain(fsRoot);
    expect(JSON.stringify(usage)).not.toContain("data:image");

    const anon = await app.inject({ method: "GET", url: "/v1/media/usage" });
    expect(anon.statusCode).toBe(401);
  });

  it("storage accounting is strictly user-scoped", async () => {
    const other = await createUser(app, `media-ops-b-${Date.now()}@test.local`);
    const res = await other.inject({ method: "GET", url: "/v1/media/usage" });
    expect(res.statusCode).toBe(200);
    expect(res.json().objects).toBe(0);
    expect(res.json().total_bytes).toBe(0);
    expect(res.json().by_project).toHaveLength(0);
  });

  it("a failed blob delete never vanishes: tombstoned, audited, then recovered", async () => {
    const created = await capture(user);
    const mediaRow = await db.query<{ storage_key: string; thumb_key: string }>(
      `SELECT storage_key, thumb_key FROM moment_media WHERE moment_id = $1`,
      [created.id],
    );
    const keys = [mediaRow.rows[0]!.storage_key, mediaRow.rows[0]!.thumb_key];

    store.failDeletes = true;
    try {
      const del = await user.inject({
        method: "DELETE",
        url: `/v1/context/moments/${created.id}`,
      });
      // The user's delete SUCCEEDS even though the store is down…
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toBe(true);
      expect(del.json().media).toBe(0);
      expect(del.json().media_queued).toBe(2); // full + thumb
    } finally {
      store.failDeletes = false;
    }

    // …the moment row is gone, the blobs are tombstoned, the audit says so.
    const gone = await db.query(`SELECT 1 FROM context_moments WHERE id = $1`, [created.id]);
    expect(gone.rows).toHaveLength(0);
    const queue = await db.query(
      `SELECT storage_key, attempts FROM media_delete_queue WHERE user_id = $1 ORDER BY storage_key`,
      [user.userId],
    );
    expect(queue.rows.map((r) => r.storage_key).sort()).toEqual([...keys].sort());
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'moment.delete'`,
      [created.id],
    );
    expect(audit.rows[0].detail.queued_media_deletions).toBe(2);
    expect(audit.rows[0].detail.deleted_media_objects).toBe(0);
    // Blobs still physically exist (delete failed) — proving nothing leaked
    // out of tracking.
    await access(join(fsRoot, keys[0]!));

    // Recovery path: cleanup drains the queue once the store is healthy.
    const report = await runMediaCleanup(db, store, {
      deleteOrphans: true,
      minAgeMinutes: 9999, // age guard must NOT protect tombstoned keys
    });
    // >= because earlier suites may have left their own (already-satisfied)
    // tombstones; ours are provably drained by the assertions below.
    expect(report.queueDeleted).toBeGreaterThanOrEqual(2);
    expect(report.queueRemaining).toBe(0);
    await expect(access(join(fsRoot, keys[0]!))).rejects.toThrow();
    const drained = await db.query(`SELECT 1 FROM media_delete_queue WHERE user_id = $1`, [
      user.userId,
    ]);
    expect(drained.rows).toHaveLength(0);
  });

  it("finds orphan blobs, honors dry-run and the age guard, deletes only real orphans", async () => {
    const valid = await capture(user);
    const validKey = (
      await db.query<{ storage_key: string }>(
        `SELECT storage_key FROM moment_media WHERE moment_id = $1`,
        [valid.id],
      )
    ).rows[0]!.storage_key;

    // An old orphan (crash between blob write and DB insert, hours ago)…
    const oldOrphanKey = `${user.userId}/${valid.id}/deadbeef-orphan`;
    await store.put(oldOrphanKey, Buffer.from("ciphertext-orphan"));
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(join(fsRoot, oldOrphanKey), twoHoursAgo, twoHoursAgo);
    // …and a fresh one (could be an in-flight capture RIGHT NOW).
    const freshOrphanKey = `${user.userId}/${valid.id}/deadbeef-fresh`;
    await store.put(freshOrphanKey, Buffer.from("ciphertext-fresh"));

    // Dry run: reported, nothing touched, nothing audited.
    const dry = await runMediaCleanup(db, store, { deleteOrphans: false, minAgeMinutes: 60 });
    expect(dry.dryRun).toBe(true);
    expect(dry.orphans).toBe(1); // the old one
    expect(dry.orphansSkippedRecent).toBe(1); // the fresh one
    expect(dry.orphansDeleted).toBe(0);
    await access(join(fsRoot, oldOrphanKey));
    const noAudit = await db.query(
      `SELECT 1 FROM audit_log WHERE user_id = $1 AND event_type = 'media.cleanup'`,
      [user.userId],
    );
    expect(noAudit.rows).toHaveLength(0);

    // Delete mode: old orphan removed, fresh orphan spared, valid media intact.
    const real = await runMediaCleanup(db, store, { deleteOrphans: true, minAgeMinutes: 60 });
    expect(real.orphansDeleted).toBe(1);
    expect(real.orphansSkippedRecent).toBe(1);
    await expect(access(join(fsRoot, oldOrphanKey))).rejects.toThrow();
    await access(join(fsRoot, freshOrphanKey)); // still there (age guard)
    await access(join(fsRoot, validKey)); // valid media untouched
    const stillServed = await user.inject({ method: "GET", url: valid.media[0]!.url });
    expect(stillServed.statusCode).toBe(200);

    // Audited with counts only.
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'media.cleanup'`,
      [user.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail.orphans_deleted).toBe(1);
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain("deadbeef");

    await store.delete(freshOrphanKey); // tidy up for later tests
  });

  it("adapter media access is guarded by redaction state (and never silent)", async () => {
    const media = new MediaService(db, store, [KEY]);

    const applied = await capture(user); // FakeOcr clean → state 'applied'
    const ok = await media.getForAdapter(user.userId, applied.media[0]!.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.redactionState).toBe("applied");
      expect(ok.data.subarray(1, 4).toString("latin1")).toBe("PNG"); // decrypted
    }

    // M15 (Hermes P1): capture no longer STORES unsafe media at all, so to
    // exercise the adapter guard against an unsafe row we flip a genuinely
    // 'applied' blob to 'failed' — the blob still decrypts, so ONLY the
    // redaction-state gate can refuse it.
    const toFlip = await capture(user);
    const failedMediaId = toFlip.media[0]!.id;
    await db.query("UPDATE moment_media SET redaction_state = 'failed' WHERE id = $1", [
      failedMediaId,
    ]);
    const refused = await media.getForAdapter(user.userId, failedMediaId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("redaction_not_applied");

    // The user's EXPLICIT override is the only way through.
    const overridden = await media.getForAdapter(user.userId, failedMediaId, {
      allowUnredacted: true,
    });
    expect(overridden.ok).toBe(true);

    // Cross-user: someone else's media is indistinguishable from none.
    const other = await createUser(app, `media-ops-c-${Date.now()}@test.local`);
    const foreign = await media.getForAdapter(other.userId, applied.media[0]!.id);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe("not_found");
  });

  it("NOVA_MEDIA_VIEW_AUDIT=on audits direct views; default stays quiet", async () => {
    const created = await capture(user);

    // Default app: no view audit rows.
    await user.inject({ method: "GET", url: created.media[0]!.url });
    const quiet = await db.query(
      `SELECT 1 FROM audit_log WHERE user_id = $1 AND event_type = 'media.view'`,
      [user.userId],
    );
    expect(quiet.rows).toHaveLength(0);

    // Opt-in app on the same DB/store: views audited (id + variant only).
    const auditingApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
        NOVA_MEDIA_VIEW_AUDIT: "on",
      }),
      ocr,
      objectStore: store,
    });
    await auditingApp.ready();
    try {
      const login = await auditingApp.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: user.email, password: "integration-test-password" },
      });
      const token = login.json().token as string;
      const res = await auditingApp.inject({
        method: "GET",
        url: `${created.media[0]!.url}?variant=thumb`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const audited = await db.query(
        `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'media.view'`,
        [user.userId],
      );
      expect(audited.rows).toHaveLength(1);
      expect(audited.rows[0].detail.variant).toBe("thumb");
      expect(JSON.stringify(audited.rows[0].detail)).not.toContain("data:image");
    } finally {
      await auditingApp.close();
    }
  });
});
