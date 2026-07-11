import { parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M15B (Hermes delta D01): a LEGACY row holding inline `data:image` in its
 * payload (pre-M8 / un-migrated) must not leak that image through ANY
 * outward path — single read, list, legacy /v1/export, or account export.
 */
const databaseUrl = process.env.DATABASE_URL;
const KEY_HEX = randomBytes(32).toString("hex");
parseEncryptionKey(KEY_HEX);

const INLINE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!databaseUrl)("M15B: legacy inline media never leaks outward", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let momentId: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: join(tmpdir(), `nova-m15b-${Date.now()}`),
      }),
      ocr: null,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `m15b-${Date.now()}@test.local`);
    // Insert a pre-M8 shaped row DIRECTLY: inline screenshot in the payload,
    // no moment_media row, exactly how old code left it.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, source_mode, payload, extracted_text, image_redaction)
       VALUES ($1, 'instant_capture', $2, 'legacy inline row', '{}') RETURNING id`,
      [user.userId, JSON.stringify({ screenshot_data_url: INLINE, dom_extract: { main_text: "legacy" } })],
    );
    momentId = rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("single GET does not return the inline data URL; flags exclusion", async () => {
    const res = await user.inject({ method: "GET", url: `/v1/context/moments/${momentId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("data:image");
    const body = res.json();
    expect(body.payload.screenshot_data_url).toBeUndefined();
    expect(body.payload.legacy_media_excluded).toBe(true);
    expect(body.payload.excluded_reason).toBe("legacy_inline_media_not_verified");
    // Non-media fields survive.
    expect(body.payload.dom_extract.main_text).toBe("legacy");
  });

  it("list does not return the inline data URL", async () => {
    const res = await user.inject({ method: "GET", url: "/v1/context/moments?limit=50" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("data:image");
  });

  it("legacy /v1/export does not include the inline data URL", async () => {
    const res = await user.inject({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("data:image");
    const moment = res.json().moments.find((m: { id: string }) => m.id === momentId);
    expect(moment.payload.legacy_media_excluded).toBe(true);
  });

  it("full account export (?media=full) does not include the inline data URL", async () => {
    const res = await user.inject({ method: "GET", url: "/v1/export/account?media=full" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("data:image");
  });

  it("search results do not include the inline data URL", async () => {
    const res = await user.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { query: "legacy" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("data:image");
  });
});
