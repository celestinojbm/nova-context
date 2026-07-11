import { readMediaForAdapter } from "@nova/context-engine/media-gate";
import { parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { storeFromEnv } from "../../src/media/object-store.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M15 — Hermes P1 alpha-blocker regressions: visual media is fail-safe.
 * Unredacted pixels are never STORED, never READ back, and never EXPORTED.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const KEY = parseEncryptionKey(KEY_HEX);

/** OCR fake: clean → 'applied'; fail → OCR throws (redaction failure). */
class SwitchOcr implements OcrEngine {
  readonly name = "switch";
  mode: "clean" | "fail" = "clean";
  async recognize(): Promise<{ words: OcrWord[] }> {
    if (this.mode === "fail") throw new Error("simulated ocr crash");
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 40, y1: 20 }] };
  }
}

async function png(): Promise<string> {
  const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}

describe.skipIf(!databaseUrl)("M15: visual media fail-safe (Hermes P1)", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let fsRoot: string;
  let env: ReturnType<typeof loadEnv>;
  const ocr = new SwitchOcr();

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-m15-${Date.now()}`);
    env = loadEnv({
      DATABASE_URL: databaseUrl,
      NOVA_ENCRYPTION_KEY: KEY_HEX,
      NOVA_MEDIA_FS_ROOT: fsRoot,
    });
    app = await buildApp({ env, ocr });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `m15-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  async function capture(
    mode: "clean" | "fail",
    extra: Record<string, unknown> = {},
  ): Promise<any> {
    ocr.mode = mode;
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://m15.example.com/x", title: "M15" },
        payload: { screenshot_data_url: await png() },
        extracted_text: "m15 media safety",
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it("default capture path is safe: no strict flag + OCR failure stores NO media", async () => {
    // The client omits strict_image_redaction entirely (schema default true).
    const created = await capture("fail");
    expect(created.image_redaction.state).toBe("blocked_strict");
    expect(created.media).toHaveLength(0);
    const rows = await db.query(
      "SELECT count(*)::int AS n FROM moment_media WHERE moment_id = $1",
      [created.id],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("server OVERRIDES an explicit unsafe client flag in production", async () => {
    // A malicious/old client sends strict_image_redaction:false with a
    // failing OCR. In production the server forces strict → image dropped.
    const prodEnv = loadEnv({
      DATABASE_URL: databaseUrl,
      NODE_ENV: "production",
      NOVA_SIGNUP: "open",
      NOVA_ENCRYPTION_KEY: KEY_HEX,
      NOVA_MEDIA_FS_ROOT: join(tmpdir(), `nova-m15-prod-${Date.now()}`),
      NOVA_RATE_LIMIT_PREFIX: `m15-prod-${Date.now()}`,
    });
    const prodApp = await buildApp({ env: prodEnv, ocr });
    await prodApp.ready();
    try {
      const prodUser = await createUser(prodApp, `m15-prod-${Date.now()}@test.local`);
      ocr.mode = "fail";
      const res = await prodUser.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { title: "prod" },
          payload: { screenshot_data_url: await png() },
          extracted_text: "prod override",
          strict_image_redaction: false, // <-- the client tries to weaken it
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.image_redaction.state).toBe("blocked_strict");
      expect(body.media).toHaveLength(0);
    } finally {
      await prodApp.close();
    }
  });

  it("direct /v1/media/:id refuses pixels for media in an unsafe state", async () => {
    // Store a genuinely-applied image (real encrypted blob), then flip its
    // row to 'failed' — the blob still exists & decrypts, so ONLY the state
    // gate can block the read.
    const created = await capture("clean");
    const mediaId = created.media[0].id;
    // control: safe read works.
    const ok = await user.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(ok.statusCode).toBe(200);

    await db.query("UPDATE moment_media SET redaction_state = 'failed' WHERE id = $1", [mediaId]);
    const blocked = await user.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(blocked.statusCode).toBe(404);
    const blockedThumb = await user.inject({
      method: "GET",
      url: `/v1/media/${mediaId}?variant=thumb`,
    });
    expect(blockedThumb.statusCode).toBe(404);
  });

  it("legacy /v1/export never inlines pixels for unsafe media", async () => {
    const created = await capture("clean");
    const mediaId = created.media[0].id;
    await db.query("UPDATE moment_media SET redaction_state = 'skipped' WHERE id = $1", [mediaId]);
    const exp = await user.inject({ method: "GET", url: "/v1/export" });
    expect(exp.statusCode).toBe(200);
    const moment = exp.json().moments.find((m: { id: string }) => m.id === created.id);
    const item = moment.media.find((m: { id: string }) => m.id === mediaId);
    expect(item.data_url).toBeNull();
    expect(item.excluded_reason).toBe("redaction_not_applied");
    // And no data:image survives anywhere in that moment's media.
    expect(JSON.stringify(moment.media)).not.toContain("data:image");
  });

  it("account export ?media=full excludes unsafe media with a reason", async () => {
    const created = await capture("clean");
    const mediaId = created.media[0].id;
    await db.query("UPDATE moment_media SET redaction_state = 'failed' WHERE id = $1", [mediaId]);
    const exp = await user.inject({ method: "GET", url: "/v1/export/account?media=full" });
    expect(exp.statusCode).toBe(200);
    const moment = exp.json().moments.find((m: { id: string }) => m.id === created.id);
    const item = moment.media.find((m: { id: string }) => m.id === mediaId);
    expect(item.data_url).toBeNull();
    expect(item.excluded_reason).toBe("redaction_not_applied");
  });

  it("the shared adapter gate blocks unsafe media (Notion/adapters)", async () => {
    const created = await capture("clean");
    const mediaId = created.media[0].id;
    await db.query("UPDATE moment_media SET redaction_state = 'failed' WHERE id = $1", [mediaId]);
    const store = storeFromEnv(env);
    const result = await readMediaForAdapter(db, store, [KEY], user.userId, mediaId, {
      allowNone: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("redaction_not_applied");
  });
});
