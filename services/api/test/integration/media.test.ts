import { decryptBytes, parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M8 suite: Media Pipeline v1 — screenshots leave the JSON payload for
 * moment_media + ENCRYPTED object storage; access is authenticated and
 * user-scoped; delete/export handle blobs; redaction still precedes
 * storage; capture-mode fail-safes hold end to end.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const KEY = parseEncryptionKey(KEY_HEX);
const EMAIL_BOX = { x0: 110, y0: 40, x1: 210, y1: 60 };

class FakeOcr implements OcrEngine {
  readonly name = "fake";
  mode: "detect" | "clean" | "fail" = "detect";
  async recognize(): Promise<{ words: OcrWord[] }> {
    if (this.mode === "fail") throw new Error("simulated ocr crash");
    if (this.mode === "clean") return { words: [{ text: "hello", ...EMAIL_BOX }] };
    return {
      words: [
        { text: "invoice", x0: 0, y0: 40, x1: 100, y1: 60 },
        { text: "alice@example.com", ...EMAIL_BOX },
        { text: "dashboard", x0: 220, y0: 40, x1: 320, y1: 60 },
      ],
    };
  }
}

async function whitePng(w = 400, h = 120): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}

function captureBody(screenshot: string | null, extra: Record<string, unknown> = {}) {
  return {
    source_mode: "instant_capture",
    source_meta: { url: "https://media.example.com/page", title: "Media Page" },
    payload: screenshot ? { screenshot_data_url: screenshot } : {},
    extracted_text: "media pipeline test text",
    intent_text: null,
    ...extra,
  };
}

describe.skipIf(!databaseUrl)("M8: media pipeline", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let fsRoot: string;
  const ocr = new FakeOcr();

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-media-test-${Date.now()}`);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `media-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  async function capture(extra: Record<string, unknown> = {}) {
    ocr.mode = "detect";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(await whitePng(), extra),
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it("stores media OUTSIDE the payload: no inline base64, moment_media row, encrypted blob", async () => {
    const created = await capture();
    expect(created.media).toHaveLength(1);
    expect(created.media[0].kind).toBe("screenshot");
    expect(created.media[0].url).toBe(`/v1/media/${created.media[0].id}`);
    expect(created.media[0].thumbnail_url).toContain("variant=thumb");

    const { rows } = await db.query(
      "SELECT payload, ocr_text FROM context_moments WHERE id = $1",
      [created.id],
    );
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
    // M8 search: non-sensitive OCR words are indexed; the email is NOT.
    expect(rows[0].ocr_text).toContain("invoice");
    expect(rows[0].ocr_text).not.toContain("alice@example.com");

    const mediaRows = await db.query(
      "SELECT * FROM moment_media WHERE moment_id = $1",
      [created.id],
    );
    expect(mediaRows.rows).toHaveLength(1);
    const media = mediaRows.rows[0];
    expect(media.user_id).toBe(user.userId);
    expect(media.redaction_state).toBe("applied");
    expect(media.width).toBe(400);
    expect(media.encrypted).toBe(true);

    // At-rest blob: ciphertext, not a readable image.
    const blob = await readFile(join(fsRoot, media.storage_key));
    expect(blob.subarray(0, 8).toString("latin1")).not.toContain("PNG");
    expect(blob.toString("latin1")).not.toContain("IHDR");
    // The right key decrypts it back to a PNG with the email box masked.
    const plain = decryptBytes(KEY, blob);
    expect(plain.subarray(1, 4).toString("latin1")).toBe("PNG");
    const img = await Jimp.fromBuffer(plain);
    expect(img.getPixelColor(160, 50)).toBe(0x000000ff);

    // Audit carries the count, never pixels or values.
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'capture'`,
      [created.id],
    );
    expect(audit.rows[0].detail.media_stored).toBe(1);
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain("data:image");
  });

  it("serves media only to its owner (authenticated, user-scoped, proxied)", async () => {
    const created = await capture();
    const mediaId = created.media[0].id;

    const anon = await app.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(anon.statusCode).toBe(401);

    const own = await user.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(own.statusCode).toBe(200);
    expect(own.headers["content-type"]).toBe("image/png");
    expect(own.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");
    const img = await Jimp.fromBuffer(own.rawPayload);
    expect(img.getPixelColor(160, 50)).toBe(0x000000ff); // still masked

    const thumb = await user.inject({
      method: "GET",
      url: `/v1/media/${mediaId}?variant=thumb`,
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
    const thumbImg = await Jimp.fromBuffer(thumb.rawPayload);
    expect(thumbImg.bitmap.width).toBeLessThanOrEqual(320);

    const bob = await createUser(app, `media-bob-${Date.now()}@test.local`);
    const cross = await bob.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(cross.statusCode).toBe(404);
  });

  it("timeline and detail responses carry media refs", async () => {
    const created = await capture();
    const list = await user.inject({ method: "GET", url: "/v1/context/moments?limit=5" });
    const item = list.json().items.find((m: { id: string }) => m.id === created.id);
    expect(item.media).toHaveLength(1);
    const detail = await user.inject({ method: "GET", url: `/v1/context/moments/${created.id}` });
    expect(detail.json().media[0].id).toBe(created.media[0].id);
  });

  it("deleting a moment removes media rows AND blobs", async () => {
    const created = await capture();
    const media = created.media[0];
    const { rows } = await db.query(
      "SELECT storage_key, thumb_key FROM moment_media WHERE id = $1",
      [media.id],
    );
    const res = await user.inject({
      method: "DELETE",
      url: `/v1/context/moments/${created.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().media).toBe(1);

    const gone = await db.query("SELECT 1 FROM moment_media WHERE id = $1", [media.id]);
    expect(gone.rowCount).toBe(0);
    await expect(readFile(join(fsRoot, rows[0].storage_key))).rejects.toThrow();
    await expect(readFile(join(fsRoot, rows[0].thumb_key))).rejects.toThrow();

    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'moment.delete'`,
      [created.id],
    );
    expect(audit.rows[0].detail.deleted_media_objects).toBe(1);
  });

  it("export carries redacted media as data URLs with metadata", async () => {
    const created = await capture();
    const res = await user.inject({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format_version).toBe(2);
    const moment = body.moments.find((m: { id: string }) => m.id === created.id);
    expect(moment.media).toHaveLength(1);
    expect(moment.media[0].redaction_state).toBe("applied");
    const img = await Jimp.fromBuffer(
      Buffer.from(moment.media[0].data_url.split(",")[1], "base64"),
    );
    expect(img.getPixelColor(160, 50)).toBe(0x000000ff); // exported form is masked
  });

  it("live-saved moments flow through the same pipeline", async () => {
    ocr.mode = "detect";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "live_context",
        source_meta: { url: "https://live.example.com", title: "Live" },
        payload: {
          screenshot_data_url: await whitePng(),
          live_session: {
            started_at: new Date().toISOString(),
            saved_at: new Date().toISOString(),
            duration_ms: 1000,
            frame_count: 3,
            qa: [],
          },
        },
        extracted_text: "live snapshot",
        intent_text: null,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.media).toHaveLength(1);
    const { rows } = await db.query("SELECT payload FROM context_moments WHERE id = $1", [
      body.id,
    ]);
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
  });

  it("strict-mode OCR failure stores NO media anywhere", async () => {
    ocr.mode = "fail";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(await whitePng(), { strict_image_redaction: true }),
    });
    const body = res.json();
    expect(body.image_redaction.state).toBe("blocked_strict");
    expect(body.media).toHaveLength(0);
    const mediaRows = await db.query("SELECT 1 FROM moment_media WHERE moment_id = $1", [
      body.id,
    ]);
    expect(mediaRows.rowCount).toBe(0);
  });

  it("screenshot-disabled mode stores NO media", async () => {
    const noStore = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
        NOVA_SCREENSHOT_STORAGE: "off",
      }),
      ocr,
    });
    await noStore.ready();
    try {
      const u = await createUser(noStore, `media-ns-${Date.now()}@test.local`);
      ocr.mode = "detect";
      const res = await u.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(await whitePng()),
      });
      const body = res.json();
      expect(body.image_redaction.state).toBe("storage_disabled");
      expect(body.media).toHaveLength(0);
      const mediaRows = await db.query("SELECT 1 FROM moment_media WHERE moment_id = $1", [
        body.id,
      ]);
      expect(mediaRows.rowCount).toBe(0);
    } finally {
      await noStore.close();
    }
  });

  it("without the encryption key the pipeline fails closed: images dropped, never stored", async () => {
    const keyless = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_MEDIA_FS_ROOT: fsRoot }),
      ocr,
    });
    await keyless.ready();
    try {
      const u = await createUser(keyless, `media-nokey-${Date.now()}@test.local`);
      ocr.mode = "detect";
      const res = await u.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(await whitePng()),
      });
      const body = res.json();
      expect(body.image_redaction.state).toBe("media_unavailable");
      expect(body.media).toHaveLength(0);
      const { rows } = await db.query(
        "SELECT payload FROM context_moments WHERE id = $1",
        [body.id],
      );
      expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
      const mediaRows = await db.query("SELECT 1 FROM moment_media WHERE moment_id = $1", [
        body.id,
      ]);
      expect(mediaRows.rowCount).toBe(0);

      const media = await u.inject({
        method: "GET",
        url: "/v1/media/00000000-0000-4000-8000-000000000000",
      });
      expect(media.statusCode).toBe(503);
    } finally {
      await keyless.close();
    }
  });

  it("nothing under the media root is plaintext (every blob is ciphertext)", async () => {
    await capture();
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(fsRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const head = (await readFile(file)).subarray(0, 16).toString("latin1");
      expect(head).not.toContain("PNG");
      expect(head).not.toContain("JFIF");
      expect(head).not.toContain("Exif");
    }
  });
});
