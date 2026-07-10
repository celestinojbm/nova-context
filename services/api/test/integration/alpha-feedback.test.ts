import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M13: private-alpha feedback intake. Category-allowlisted, text-only,
 * user-scoped, rate-limited; the audit trail and analytics record the
 * category ONLY — the message lives in exactly one user-deletable table
 * and never reaches logs.
 */
const databaseUrl = process.env.DATABASE_URL;

const SECRET_MARKER = `feedback-secret-${randomBytes(8).toString("hex")}`;

describe.skipIf(!databaseUrl)("M13: alpha feedback intake", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let stranger: TestUser;
  const logLines: string[] = [];

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl }),
      ocr: null,
      loggerStream: { write: (msg: string) => void logLines.push(msg) },
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    const stamp = Date.now();
    user = await createUser(app, `feedback-${stamp}@test.local`);
    stranger = await createUser(app, `feedback-stranger-${stamp}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("rejects unknown categories, short/oversized messages, and pasted data URLs", async () => {
    const bad = async (payload: unknown) => {
      const res = await user.inject({ method: "POST", url: "/v1/feedback", payload });
      expect(res.statusCode).toBe(400);
    };
    await bad({ category: "rant", message: "not a real category" });
    await bad({ category: "bug", message: "x" });
    await bad({ category: "bug", message: "y".repeat(4001) });
    await bad({
      category: "bug",
      message: `look at this screenshot data:image/png;base64,iVBORw0KGgo=`,
    });
    await bad({ category: "bug", message: "extra fields", extra: true });
  });

  it("stores feedback user-scoped; audit + analytics carry the category, never the message", async () => {
    const res = await user.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        category: "capture_failure",
        message: `capture button did nothing on my banking site ${SECRET_MARKER}`,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();

    // Own listing shows it; a stranger's listing does not.
    const mine = (await user.inject({ method: "GET", url: "/v1/feedback" })).json();
    expect(mine.items.some((i: { id: string }) => i.id === id)).toBe(true);
    const theirs = (await stranger.inject({ method: "GET", url: "/v1/feedback" })).json();
    expect(theirs.items.some((i: { id: string }) => i.id === id)).toBe(false);

    // Audit row exists and contains the category ONLY.
    const audit = await db.query(
      `SELECT detail FROM audit_log
       WHERE user_id = $1 AND event_type = 'feedback.submitted' AND subject_id = $2`,
      [user.userId, id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].detail)).toContain("capture_failure");
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain(SECRET_MARKER);

    // Product event lands (fire-and-forget → poll) with category-only props.
    let event: pg.QueryResult | null = null;
    for (let i = 0; i < 40; i++) {
      event = await db.query(
        `SELECT props FROM product_events
         WHERE user_id = $1 AND event = 'feedback_submitted'
         ORDER BY created_at DESC LIMIT 1`,
        [user.userId],
      );
      if (event.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(event!.rows[0].props.category).toBe("capture_failure");
    expect(JSON.stringify(event!.rows[0].props)).not.toContain(SECRET_MARKER);

    // The message text never reaches the log stream.
    expect(logLines.join("")).not.toContain(SECRET_MARKER);
  });

  it("rate-limits feedback submission", async () => {
    const limited = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_RATE_LIMIT_MAX: "1" }),
      ocr: null,
    });
    await limited.ready();
    try {
      const u = await createUser(limited, `feedback-limit-${Date.now()}@test.local`);
      const one = await u.inject({
        method: "POST",
        url: "/v1/feedback",
        payload: { category: "ux", message: "first item goes through" },
      });
      expect(one.statusCode).toBe(201);
      const two = await u.inject({
        method: "POST",
        url: "/v1/feedback",
        payload: { category: "ux", message: "second should be limited" },
      });
      expect(two.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
