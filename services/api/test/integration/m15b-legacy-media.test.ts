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

// M15C (Hermes M15B-R01): mixed-case variants must be caught too. A row with
// uppercase/mixed `DATA:image` in a normal field, a nested field, and inside
// an array — none of these may leak through any outward path.
const MIXED_TOP = "DATA:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const MIXED_NESTED = "Data:Image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const MIXED_SVG = "data:IMAGE/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>";
const anyDataImage = /data:image/i;

describe.skipIf(!databaseUrl)("M15B: legacy inline media never leaks outward", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let momentId: string;
  let mixedId: string;

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

    // A second legacy row whose inline media is MIXED-CASE and hidden in a
    // top-level field, a nested object, and an array element.
    const { rows: mixedRows } = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, source_mode, payload, extracted_text, image_redaction)
       VALUES ($1, 'instant_capture', $2, 'legacy mixed case row', '{}') RETURNING id`,
      [
        user.userId,
        JSON.stringify({
          top: MIXED_TOP,
          live_session: { screenshot: MIXED_NESTED, frames: [MIXED_SVG, "keep-text"] },
          dom_extract: { main_text: "mixedcase" },
        }),
      ],
    );
    mixedId = mixedRows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("single GET does not return the inline data URL; flags exclusion", async () => {
    const res = await user.inject({ method: "GET", url: `/v1/context/moments/${momentId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(anyDataImage);
    const body = res.json();
    expect(body.payload.screenshot_data_url).toBeUndefined();
    expect(body.payload.legacy_media_excluded).toBe(true);
    expect(body.payload.excluded_reason).toBe("legacy_inline_media_not_verified");
    // Non-media fields survive.
    expect(body.payload.dom_extract.main_text).toBe("legacy");
  });

  it("single GET of a MIXED-CASE row excludes every variant (top/nested/array)", async () => {
    const res = await user.inject({ method: "GET", url: `/v1/context/moments/${mixedId}` });
    expect(res.statusCode).toBe(200);
    // No case variant of an inline image survives anywhere in the response.
    expect(res.body).not.toMatch(anyDataImage);
    expect(res.body).not.toContain("<svg");
    const body = res.json();
    expect(body.payload.top).toBeUndefined();
    expect(body.payload.live_session.screenshot).toBeUndefined();
    expect(body.payload.legacy_media_excluded).toBe(true);
    // Non-media text in the same array/objects survives.
    expect(res.body).toContain("keep-text");
    expect(body.payload.dom_extract.main_text).toBe("mixedcase");
  });

  it("list does not return the inline data URL (any case)", async () => {
    const res = await user.inject({ method: "GET", url: "/v1/context/moments?limit=50" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(anyDataImage);
  });

  it("legacy /v1/export does not include the inline data URL (any case)", async () => {
    const res = await user.inject({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(anyDataImage);
    const moments = res.json().moments as Array<{ id: string; payload: Record<string, unknown> }>;
    expect(moments.find((m) => m.id === momentId)!.payload.legacy_media_excluded).toBe(true);
    expect(moments.find((m) => m.id === mixedId)!.payload.legacy_media_excluded).toBe(true);
  });

  it("full account export (?media=full) does not include the inline data URL (any case)", async () => {
    const res = await user.inject({ method: "GET", url: "/v1/export/account?media=full" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(anyDataImage);
    expect(res.body).not.toContain("<svg");
  });

  it("search results do not include the inline data URL (any case)", async () => {
    for (const query of ["legacy", "mixedcase"]) {
      const res = await user.inject({
        method: "POST",
        url: "/v1/memory/search",
        payload: { query },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(anyDataImage);
    }
  });
});
