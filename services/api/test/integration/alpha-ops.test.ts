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
import { runPreflight } from "../../src/ops/preflight.js";
import { runAlphaReport } from "../../src/ops/report.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M13: production preflight, the alpha usage report, and the cost/guardrail
 * additions to /v1/ops/status. Counts, booleans, and short names only —
 * the suite also proves the new surfaces carry no captured content.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
parseEncryptionKey(KEY_HEX);

class FakeOcr implements OcrEngine {
  readonly name = "fake";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 10, y1: 10 }] };
  }
}

describe.skipIf(!databaseUrl)("M13: preflight / report / status guardrails", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let user: TestUser;
  let fsRoot: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-alpha-ops-${Date.now()}`);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: new FakeOcr(),
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    user = await createUser(app, `alpha-ops-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  describe("ops:preflight", () => {
    it("passes on a healthy dev-style config (probes DB, store, keys)", async () => {
      const report = await runPreflight({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
        ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
      });
      expect(report.ok).toBe(true);
      const names = report.checks.map((c) => c.name);
      for (const expected of ["env", "encryption_key", "signup_policy", "postgres", "migrations", "media_store"]) {
        expect(names).toContain(expected);
      }
    });

    it("fails closed on production foot-guns: missing key, open signup, partial Notion", async () => {
      const noKey = await runPreflight({ NODE_ENV: "production", DATABASE_URL: databaseUrl });
      expect(noKey.ok).toBe(false);
      expect(noKey.checks[0]!.name).toBe("env");
      expect(noKey.checks[0]!.detail).toMatch(/NOVA_ENCRYPTION_KEY/);

      const openSignup = await runPreflight({
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
        NOVA_SIGNUP: "open",
      });
      expect(openSignup.ok).toBe(false);
      expect(
        openSignup.checks.find((c) => c.name === "signup_policy")!.status,
      ).toBe("fail");

      const partialNotion = await runPreflight({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
        NOTION_CLIENT_ID: "client-only",
      });
      expect(partialNotion.ok).toBe(false);
      expect(partialNotion.checks.find((c) => c.name === "notion")!.detail).toContain("1/3");
    });

    it("flags lingering previous keys as unfinished rotation (warn, not fail)", async () => {
      const report = await runPreflight({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_ENCRYPTION_KEYS_PREVIOUS: randomBytes(32).toString("hex"),
        NOVA_MEDIA_FS_ROOT: fsRoot,
      });
      const prev = report.checks.find((c) => c.name === "previous_keys")!;
      expect(prev.status).toBe("warn");
      expect(prev.detail).toContain("rotation");
      expect(report.ok).toBe(true);
    });

    it("never prints key material", async () => {
      const report = await runPreflight({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      });
      expect(JSON.stringify(report)).not.toContain(KEY_HEX);
    });
  });

  describe("ops:report (alpha usage loop)", () => {
    it("aggregates events, friction, usage, feedback — counts and excerpts only", async () => {
      // Seed one capture WITH media (usage + storage numbers), one failed
      // capture event, and one feedback item.
      const img = new Jimp({ width: 64, height: 32, color: 0xffffffff });
      const png = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
      const captured = await user.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { url: "https://alpha.example.com/report" },
          payload: { screenshot_data_url: png },
          extracted_text: "alpha report seed moment",
          intent_text: "remind me to seed the report",
        },
      });
      expect(captured.statusCode).toBe(201);
      await user.inject({
        method: "POST",
        url: "/v1/events",
        payload: { event: "capture_failed", props: { reason: "seeded" } },
      });
      await user.inject({
        method: "POST",
        url: "/v1/feedback",
        payload: { category: "search_failure", message: "seeded report feedback item" },
      });

      // Client events are fire-and-forget — wait for the seeded one.
      for (let i = 0; i < 40; i++) {
        const { rows } = await db.query(
          `SELECT 1 FROM product_events WHERE user_id = $1 AND event = 'capture_failed'`,
          [user.userId],
        );
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const report = await runAlphaReport(db, { days: 1, mediaWarnMb: 1 });
      expect(report.events["instant_capture_saved"]).toBeGreaterThanOrEqual(1);
      expect(report.events["capture_failed"]).toBeGreaterThanOrEqual(1);
      expect(report.friction.captures_failed).toBeGreaterThanOrEqual(1);
      expect(report.usage.moments).toBeGreaterThanOrEqual(1);
      expect(report.usage.media_objects).toBeGreaterThanOrEqual(1);
      expect(report.usage.media_bytes).toBeGreaterThan(0);
      const fb = report.feedback.find((f) => f.excerpt.includes("seeded report feedback"));
      expect(fb).toBeDefined();
      expect(fb!.category).toBe("search_failure");
      expect(report.feedback_by_category["search_failure"]).toBeGreaterThanOrEqual(1);
      expect(report.warnings.some((w) => w.includes("untriaged feedback"))).toBe(true);

      // Report text carries no captured content: the seeded moment's page
      // text/intent never appear (only allowlisted names + feedback excerpt).
      const text = JSON.stringify(report);
      expect(text).not.toContain("alpha report seed moment");
      expect(text).not.toContain("remind me to seed the report");
    });

    it("warns when media storage exceeds the configured threshold", async () => {
      const report = await runAlphaReport(db, { days: 1, mediaWarnMb: 0 });
      expect(report.warnings.some((w) => w.includes("threshold"))).toBe(true);
    });

    it("escalates privacy-category feedback as an incident warning", async () => {
      await user.inject({
        method: "POST",
        url: "/v1/feedback",
        payload: { category: "privacy", message: "seeded privacy concern for the report test" },
      });
      const report = await runAlphaReport(db, { days: 1 });
      expect(report.feedback_by_category["privacy"]).toBeGreaterThanOrEqual(1);
      expect(report.warnings.some((w) => w.includes("PRIVACY"))).toBe(true);
    });
  });

  describe("/v1/ops/status guardrails", () => {
    it("exposes cost/feature switches and machine-checkable warnings", async () => {
      const res = await user.inject({ method: "GET", url: "/v1/ops/status" });
      expect(res.statusCode).toBe(200);
      const status = res.json();
      expect(status.features).toMatchObject({
        live_qa: "off", // no ANTHROPIC_API_KEY in this app
        transcription: "off",
        analytics: "local",
        text_redaction: "on",
        image_redaction: "on",
        screenshot_storage: "on",
        notion: "off",
      });
      expect(Array.isArray(status.warnings)).toBe(true);
      // Worker isn't running in this suite → its warning must be present.
      expect(status.warnings.some((w: string) => w.includes("worker"))).toBe(true);
    });

    it("accepts the new M13 allowlisted client events", async () => {
      const res = await user.inject({
        method: "POST",
        url: "/v1/events",
        payload: { event: "task_created", props: { tier: 0 } },
      });
      expect(res.statusCode).toBe(202);
      const unknown = await user.inject({
        method: "POST",
        url: "/v1/events",
        payload: { event: "not_a_real_event" },
      });
      expect(unknown.statusCode).toBe(400);
    });
  });
});
