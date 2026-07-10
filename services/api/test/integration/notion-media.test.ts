import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import { Queue } from "bullmq";
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
import type { NotionOAuthClient } from "../../src/integrations/notion-oauth.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M10 suite (API side): Notion media CONSENT. The preview exposes per-media
 * eligibility; approval accepts only the user's own, redacted media on the
 * action's moment; nothing is included by default. (The worker-side upload
 * behavior is covered in services/worker's action suite.)
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const QUEUE_NAME = `test-media-consent-${Date.now()}`;

const fakeOauth: NotionOAuthClient = {
  authorizeUrl: (state) => `https://notion.test/authorize?state=${encodeURIComponent(state)}`,
  exchangeCode: async () => ({
    accessToken: "secret_media_consent_token",
    workspaceName: "Consent WS",
    workspaceId: "ws",
    botId: "bot",
  }),
};

/** OCR fake with a per-capture switch: clean → 'applied', fail → 'failed'. */
class SwitchOcr implements OcrEngine {
  readonly name = "switch";
  mode: "clean" | "fail" = "clean";
  async recognize(): Promise<{ words: OcrWord[] }> {
    if (this.mode === "fail") throw new Error("simulated ocr crash");
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 40, y1: 20 }] };
  }
}

describe.skipIf(!databaseUrl || !redisUrl)("M10: Notion media consent (API)", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  const ocr = new SwitchOcr();

  async function captureWithImage(mode: "clean" | "fail"): Promise<{
    momentId: string;
    mediaId: string | null;
    redactionState: string;
  }> {
    ocr.mode = mode;
    const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
    const png = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://consent.example.com/x", title: "Consent Page" },
        payload: { screenshot_data_url: png },
        extracted_text: "consent test",
        intent_text: null,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return {
      momentId: body.id,
      // M15: on OCR failure no media row exists — read the moment-level
      // image_redaction state, not media[0].
      mediaId: body.media[0]?.id ?? null,
      redactionState: body.image_redaction.state,
    };
  }

  async function proposeAction(momentId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
       VALUES ($1, $2, 'notion_page', 1, 'proposed', '{"title":"Consent page"}') RETURNING id`,
      [user.userId, momentId],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: join(tmpdir(), `nova-consent-${Date.now()}`),
        NOVA_ACTION_QUEUE: QUEUE_NAME,
        NOVA_RATE_LIMIT_PREFIX: `test-rl-consent-${Date.now()}`,
      }),
      notionOauth: fakeOauth,
      ocr,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `consent-${Date.now()}@test.local`);
    // Connect Notion (needed for approval).
    const start = await user.inject({ method: "POST", url: "/v1/integrations/notion/oauth/start" });
    const state = new URL(start.json().authorize_url).searchParams.get("state")!;
    const cb = await user.inject({
      method: "POST",
      url: "/v1/integrations/notion/oauth/callback",
      payload: { code: "any", state },
    });
    expect(cb.statusCode).toBe(200);
  });

  afterAll(async () => {
    const q = new Queue(QUEUE_NAME, { connection: { url: redisUrl! } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
    await app?.close();
    await db?.end();
  });

  it("preview lists each media with honest eligibility; nothing included by default", async () => {
    const applied = await captureWithImage("clean");
    expect(applied.redactionState).toBe("applied");
    // M15 (Hermes P1): OCR failure no longer STORES unredacted media at all —
    // strict is the effective default, so the image is dropped
    // ('blocked_strict') and no media row exists to be (in)eligible.
    const failed = await captureWithImage("fail");
    expect(failed.redactionState).toBe("blocked_strict");
    expect(failed.mediaId).toBeNull();

    const actionId = await proposeAction(applied.momentId);
    const preview = await user.inject({ method: "GET", url: `/v1/actions/${actionId}/preview` });
    expect(preview.statusCode).toBe(200);
    const media = preview.json().media;
    expect(media.included).toBe(false);
    expect(media.approved_ids).toEqual([]);
    expect(media.count).toBe(1);
    expect(media.items[0]).toMatchObject({
      id: applied.mediaId,
      eligible: true,
      redaction_state: "applied",
    });

    // The moment whose redaction failed carries NO media at all — there is
    // nothing to include or leak.
    const failedAction = await proposeAction(failed.momentId);
    const failedPreview = await user.inject({
      method: "GET",
      url: `/v1/actions/${failedAction}/preview`,
    });
    expect(failedPreview.json().media.count).toBe(0);
    expect(failedPreview.json().media.items).toEqual([]);
  });

  it("approval stores ONLY explicitly ticked media, and audits the count", async () => {
    const { momentId, mediaId } = await captureWithImage("clean");
    const actionId = await proposeAction(momentId);

    const res = await user.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/approve`,
      payload: { media_ids: [mediaId] },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await db.query(`SELECT payload FROM actions WHERE id = $1`, [actionId]);
    expect(rows[0].payload.media_ids).toEqual([mediaId]);

    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'action.approve'`,
      [actionId],
    );
    expect(audit.rows[0].detail.media_approved).toBe(1);

    // Post-approval preview reflects the consent.
    const preview = await user.inject({ method: "GET", url: `/v1/actions/${actionId}/preview` });
    expect(preview.json().media.included).toBe(true);
    expect(preview.json().media.approved_ids).toEqual([mediaId]);
  });

  it("approval WITHOUT ticked media records an explicit empty consent", async () => {
    const { momentId } = await captureWithImage("clean");
    const actionId = await proposeAction(momentId);
    const res = await user.inject({ method: "POST", url: `/v1/actions/${actionId}/approve` });
    expect(res.statusCode).toBe(200);
    const { rows } = await db.query(`SELECT payload FROM actions WHERE id = $1`, [actionId]);
    expect(rows[0].payload.media_ids).toEqual([]);
  });

  it("rejects unredacted media, foreign media, and media from another moment — before any state change", async () => {
    const { momentId } = await captureWithImage("clean");
    const actionId = await proposeAction(momentId);

    // M15 (Hermes P1): unredacted media is never STORED, so it cannot even be
    // referenced. A capture whose OCR failed yields no media row at all.
    const failed = await captureWithImage("fail");
    expect(failed.mediaId).toBeNull();

    // A second clean moment's media (owned + redacted, but NOT on this
    // action's moment) must still be rejected.
    const otherMoment = await captureWithImage("clean");
    const wrongMoment = await user.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/approve`,
      payload: { media_ids: [otherMoment.mediaId] },
    });
    expect(wrongMoment.statusCode).toBe(400);
    expect(wrongMoment.json().error).toBe("invalid_media");

    // Another user's media id.
    const other = await createUser(app, `consent-b-${Date.now()}@test.local`);
    const otherCapture = await (async () => {
      ocr.mode = "clean";
      const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
      const png = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
      const res = await other.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { url: "https://consent.example.com/o", title: "Other" },
          payload: { screenshot_data_url: png },
          extracted_text: "other user capture",
          intent_text: null,
        },
      });
      return res.json().media[0].id as string;
    })();
    const foreign = await user.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/approve`,
      payload: { media_ids: [otherCapture] },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().rejected_ids).toContain(otherCapture);

    // The action never left 'proposed'.
    const { rows } = await db.query(`SELECT status FROM actions WHERE id = $1`, [actionId]);
    expect(rows[0].status).toBe("proposed");
  });
});
