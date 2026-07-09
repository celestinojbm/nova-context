import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { LiveAnswerRequest } from "@nova/schema";
import type { LiveQaProvider } from "@nova/model-router";
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
import { createUser, type TestUser } from "./helpers.js";

/**
 * M7 suite: Visual Redaction v1 end to end — screenshots are masked BEFORE
 * storage (pixel-verified), before live Q&A (provider sees only masked
 * frames), and therefore before export; strict mode and the storage kill
 * switch fail safe; audit carries counts, never values.
 * Since M8 the storage destination is the media pipeline (moment_media +
 * encrypted blobs), so "stored image" assertions read through /v1/media.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const mediaEnv = () => ({
  DATABASE_URL: databaseUrl,
  NOVA_ENCRYPTION_KEY: KEY_HEX,
  NOVA_MEDIA_FS_ROOT: join(tmpdir(), `nova-visual-test-${Date.now()}`),
});

const EMAIL_BOX = { x0: 110, y0: 40, x1: 210, y1: 60 };

/** Controllable fake OCR: 'detect' reports an email box, 'clean' reports
 * nothing sensitive, 'fail' simulates an OCR crash. */
class FakeOcr implements OcrEngine {
  readonly name = "fake";
  mode: "detect" | "clean" | "fail" = "detect";
  calls = 0;

  async recognize(): Promise<{ words: OcrWord[] }> {
    this.calls += 1;
    if (this.mode === "fail") throw new Error("simulated ocr crash");
    if (this.mode === "clean") {
      return { words: [{ text: "hello", ...EMAIL_BOX }] };
    }
    return {
      words: [
        { text: "email", x0: 0, y0: 40, x1: 100, y1: 60 },
        { text: "alice@example.com", ...EMAIL_BOX },
      ],
    };
  }
}

async function whitePng(w = 400, h = 120): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  const buf = await img.getBuffer(JimpMime.png);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function pixelAt(dataUrl: string, x: number, y: number): Promise<number> {
  const base64 = dataUrl.split(",")[1]!;
  const img = await Jimp.fromBuffer(Buffer.from(base64, "base64"));
  return img.getPixelColor(x, y);
}

function captureBody(screenshot: string | null, extra: Record<string, unknown> = {}) {
  return {
    source_mode: "instant_capture",
    source_meta: { url: "https://visual.example.com/page", title: "Visual Page" },
    payload: screenshot ? { screenshot_data_url: screenshot } : {},
    extracted_text: "clean page text",
    intent_text: null,
    ...extra,
  };
}

describe.skipIf(!databaseUrl)("M7: visual redaction", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  const ocr = new FakeOcr();
  let received: LiveAnswerRequest | null = null;
  const fakeQa: LiveQaProvider = {
    name: "fake",
    model: "fake",
    answer: (req) => {
      received = req;
      return Promise.resolve({ answer: "ok", grounding: "grounded" as const, model: "fake" });
    },
  };

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv(mediaEnv()),
      ocr,
      liveQa: fakeQa,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `visual-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("masks sensitive regions BEFORE storage, stores a values-free report, audits counts", async () => {
    ocr.mode = "detect";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(await whitePng()),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.image_redaction.state).toBe("applied");
    expect(body.image_redaction.tally.email).toBe(1);

    const { rows } = await db.query(
      "SELECT payload, image_redaction FROM context_moments WHERE id = $1",
      [body.id],
    );
    // M8: pixels never land in the payload — they live in moment_media.
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
    expect(body.media).toHaveLength(1);
    const served = await user.inject({ method: "GET", url: body.media[0].url });
    expect(served.statusCode).toBe(200);
    const img = await Jimp.fromBuffer(served.rawPayload);
    // Inside the email box → black; outside → white. The unredacted pixels
    // never reached storage.
    expect(img.getPixelColor(160, 50)).toBe(0x000000ff);
    expect(img.getPixelColor(300, 100)).toBe(0xffffffff);
    expect(rows[0].image_redaction.state).toBe("applied");
    expect(rows[0].image_redaction.tally.email).toBe(1);

    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'capture'`,
      [body.id],
    );
    const detail = audit.rows[0].detail;
    expect(detail.image_redaction).toBe("applied");
    expect(detail.image_redactions.email).toBe(1);
    expect(detail.images_masked).toBe(1);
    expect(detail.image_storage_disabled).toBe(false);
    expect(detail.strict_blocked).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("alice@example.com");
  });

  it("strict mode: OCR failure drops the image instead of storing it", async () => {
    ocr.mode = "fail";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(await whitePng(), { strict_image_redaction: true }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.image_redaction.state).toBe("blocked_strict");

    const { rows } = await db.query(
      "SELECT payload, image_redaction FROM context_moments WHERE id = $1",
      [body.id],
    );
    expect(rows[0].payload.screenshot_data_url).toBeUndefined();
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
    expect(rows[0].image_redaction.state).toBe("blocked_strict");

    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'capture'`,
      [body.id],
    );
    expect(audit.rows[0].detail.strict_blocked).toBe(true);
  });

  it("non-strict: OCR failure keeps the image and reports 'failed' honestly", async () => {
    ocr.mode = "fail";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(await whitePng()),
    });
    const body = res.json();
    expect(body.image_redaction.state).toBe("failed");
    // M8: the (unmasked, non-strict) image is still kept — encrypted in the
    // media pipeline with its honest redaction state, never in the payload.
    expect(body.media).toHaveLength(1);
    expect(body.media[0].redaction_state).toBe("failed");
    const { rows } = await db.query(
      "SELECT payload FROM context_moments WHERE id = $1",
      [body.id],
    );
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
    const served = await user.inject({ method: "GET", url: body.media[0].url });
    expect(served.statusCode).toBe(200);
  });

  it("captures without an image report state 'none' (text-only mode stores no image)", async () => {
    ocr.mode = "detect";
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: captureBody(null),
    });
    const body = res.json();
    expect(body.image_redaction.state).toBe("none");
    const { rows } = await db.query(
      "SELECT payload FROM context_moments WHERE id = $1",
      [body.id],
    );
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
  });

  it("image redaction off (ocr null) stores with state 'skipped'", async () => {
    const offApp = await buildApp({
      env: loadEnv(mediaEnv()),
      ocr: null,
    });
    await offApp.ready();
    try {
      const u = await createUser(offApp, `visual-off-${Date.now()}@test.local`);
      const res = await u.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(await whitePng()),
      });
      expect(res.json().image_redaction.state).toBe("skipped");
    } finally {
      await offApp.close();
    }
  });

  it("screenshot storage kill switch strips images server-side", async () => {
    const noStore = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_SCREENSHOT_STORAGE: "off" }),
      ocr,
    });
    await noStore.ready();
    try {
      ocr.mode = "detect";
      const u = await createUser(noStore, `visual-nostore-${Date.now()}@test.local`);
      const res = await u.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(await whitePng()),
      });
      const body = res.json();
      expect(body.image_redaction.state).toBe("storage_disabled");
      const { rows } = await db.query(
        "SELECT payload FROM context_moments WHERE id = $1",
        [body.id],
      );
      expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");

      const audit = await db.query(
        `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'capture'`,
        [body.id],
      );
      expect(audit.rows[0].detail.image_storage_disabled).toBe(true);
    } finally {
      await noStore.close();
    }
  });

  it("live Q&A: the provider receives ONLY masked frames; unredactable frames are dropped", async () => {
    ocr.mode = "detect";
    received = null;
    const frame = await whitePng();
    const res = await user.inject({
      method: "POST",
      url: "/v1/live/answers",
      payload: {
        question: "what is on screen?",
        context: { frames: [frame], text_snippets: ["visible text"] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(received!.context.frames).toHaveLength(1);
    // The frame that reached the provider is masked at the email box.
    expect(await pixelAt(received!.context.frames[0]!, 160, 50)).toBe(0x000000ff);

    // Failure ⇒ frame dropped, question still answered.
    ocr.mode = "fail";
    received = null;
    const res2 = await user.inject({
      method: "POST",
      url: "/v1/live/answers",
      payload: { question: "and now?", context: { frames: [frame], text_snippets: [] } },
    });
    expect(res2.statusCode).toBe(200);
    expect(received!.context.frames).toHaveLength(0);
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'live.qa'
       ORDER BY created_at DESC LIMIT 1`,
      [user.userId],
    );
    expect(audit.rows[0].detail.frames_dropped).toBe(1);
    expect(audit.rows[0].detail.image_redaction).toBe("applied");
  });

  it("exports contain only the redacted image", async () => {
    ocr.mode = "detect";
    const created = (
      await user.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: captureBody(await whitePng()),
      })
    ).json();

    const res = await user.inject({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    const exported = res.json();
    const moment = exported.moments.find((m: { id: string }) => m.id === created.id);
    expect(moment).toBeTruthy();
    // M8: exports carry media as decrypted data URLs alongside the moment.
    expect(JSON.stringify(moment.payload)).not.toContain("data:image");
    expect(moment.media).toHaveLength(1);
    expect(await pixelAt(moment.media[0].data_url, 160, 50)).toBe(0x000000ff);
    expect(moment.image_redaction.state).toBe("applied");
  });
});
