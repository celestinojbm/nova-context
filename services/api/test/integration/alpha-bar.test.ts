import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { collectAlphaBarInputs, computeAlphaBar } from "../../src/ops/alpha-bar.js";
import { runAlphaReport } from "../../src/ops/report.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * Horizon-2 alpha bar (docs/ROADMAP.md) against real Postgres. Captures go
 * through the real API where the definition depends on the write path
 * (Inbox, Tier-0 auto actions); ages that need a past (retention, out-of-
 * window) are seeded with SQL. Every query is scoped to this suite's users
 * so other suites' rows in the shared database never leak into the counts.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("alpha bar (ROADMAP Horizon 2 metrics)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let alice: TestUser;
  let bobId: string;
  let carolId: string;
  let synthId: string;
  const stamp = Date.now();
  const SECRET_TEXT = `alpha bar secret page text ${stamp}`;

  async function capture(
    user: TestUser,
    opts: { project?: string | null; intent?: string | null },
  ): Promise<string> {
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://example.com/alpha", title: "Alpha" },
        extracted_text: SECRET_TEXT,
        ...(opts.intent ? { intent_text: opts.intent } : {}),
        ...(opts.project ? { project_id: opts.project } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function seedUser(email: string, ageDays: number): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, created_at) VALUES ($1, now() - make_interval(days => $2))
       RETURNING id`,
      [email, ageDays],
    );
    return rows[0]!.id;
  }

  async function seedMoment(userId: string, ageDays: number): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, source_mode, extracted_text, captured_at, created_at)
       VALUES ($1, 'instant_capture', $2,
               now() - make_interval(days => $3), now() - make_interval(days => $3))
       RETURNING id`,
      [userId, SECRET_TEXT, ageDays],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_RATE_LIMIT_PREFIX: `test-alpha-bar-${stamp}`,
      }),
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 3 });

    alice = await createUser(app, `alpha-bar-alice-${stamp}@example.test`);
    const inbox = await db.query<{ id: string }>(
      `SELECT id FROM projects WHERE user_id = $1 AND name = 'Inbox'`,
      [alice.userId],
    );
    const inboxId = inbox.rows[0]!.id;
    const project = await alice.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: `Pricing ${stamp}` },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id as string;

    // Alice, inside the window, through the API:
    //  1. real project + intent that creates a Tier-0 task (auto action);
    await capture(alice, { project: projectId, intent: "remind me to follow up on the pricing page" });
    //  2. Inbox, no intent → linked only "incl. inbox";
    await capture(alice, { project: inboxId });
    //  3. no project, no intent → later gets a Tier-1 action confirmed 12s after capture.
    const tier1Moment = await capture(alice, {});
    // Move it an hour back so its confirmation (+12s) is in the past.
    await db.query(
      `UPDATE context_moments SET created_at = now() - interval '1 hour' WHERE id = $1`,
      [tier1Moment],
    );
    await db.query(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload,
                            approved_by, approved_at, created_at)
       SELECT $1, m.id, 'notion_page', 1, 'done', '{}', $1,
              m.created_at + interval '12 seconds', m.created_at + interval '1 second'
       FROM context_moments m WHERE m.id = $2`,
      [alice.userId, tier1Moment],
    );
    // A rejected action is not a confirmed action.
    const rejectedMoment = await seedMoment(alice.userId, 2);
    await db.query(
      `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload)
       VALUES ($1, $2, 'notion_page', 1, 'rejected', '{}')`,
      [alice.userId, rejectedMoment],
    );
    // Outside a 14-day window.
    await seedMoment(alice.userId, 20);

    // Bob signed up 30 days ago and captured on day 24 (inside week 4, and
    // inside the window). Carol signed up 40 days ago and only captured on
    // day 5 → eligible for week-4 retention, not retained.
    bobId = await seedUser(`alpha-bar-bob-${stamp}@example.test`, 30);
    await seedMoment(bobId, 6);
    carolId = await seedUser(`alpha-bar-carol-${stamp}@example.test`, 40);
    await seedMoment(carolId, 35);

    // ops:smoke-style synthetic account: excluded unless asked for.
    synthId = await seedUser(`alpha-bar-${stamp}@alpha.local`, 0);
    await seedMoment(synthId, 1);
  });

  afterAll(async () => {
    await db?.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [bobId, carolId, synthId].filter(Boolean),
    ]);
    await db?.end();
    await app?.close();
  });

  const scope = (): string[] => [alice.userId, bobId, carolId, synthId];

  it("counts window captures, active users and linking without the Inbox", async () => {
    const inputs = await collectAlphaBarInputs(db, { days: 14, userIds: scope() });
    // Alice: 3 API captures + the rejected-action one (2d); the 20d one is out.
    // Bob: 1 (6d). Carol's is 35d old. Synthetic is excluded.
    expect(inputs.window_captures).toBe(5);
    expect(inputs.active_users).toBe(2);
    expect(inputs.linked_captures).toBe(1); // the real project only
    expect(inputs.linked_captures_incl_inbox).toBe(2);
  });

  it("splits captures by intent utterance and counts only confirmed actions", async () => {
    const inputs = await collectAlphaBarInputs(db, { days: 14, userIds: scope() });
    expect(inputs.captures_with_intent).toBe(1);
    expect(inputs.captures_with_intent_actioned).toBe(1); // Tier-0 task, status done
    expect(inputs.captures_without_intent).toBe(4);
    expect(inputs.captures_without_intent_actioned).toBe(1); // Tier-1 done; rejected ignored
  });

  it("measures capture-to-action from the moment row to confirmation", async () => {
    const inputs = await collectAlphaBarInputs(db, { days: 14, userIds: scope() });
    expect(inputs.confirmed_actions).toBe(2);
    // Tier-0 ≈ 0s (same request), Tier-1 = 12s → p75 = 0.25·t0 + 0.75·12 ≈ 9.
    expect(inputs.capture_to_action_p75_seconds!).toBeGreaterThan(8.9);
    expect(inputs.capture_to_action_p75_seconds!).toBeLessThan(9.5);
    expect(inputs.capture_to_action_p50_seconds!).toBeLessThan(inputs.capture_to_action_p75_seconds!);
  });

  it("computes week-4 retention over users at least 28 days old", async () => {
    const inputs = await collectAlphaBarInputs(db, { days: 14, userIds: scope() });
    expect(inputs.week4_eligible_users).toBe(2); // bob, carol (alice is new)
    expect(inputs.week4_retained_users).toBe(1); // bob
  });

  it("includes synthetic accounts only when asked", async () => {
    const withSynth = await collectAlphaBarInputs(db, {
      days: 14,
      userIds: scope(),
      includeSynthetic: true,
    });
    expect(withSynth.window_captures).toBe(6);
    expect(withSynth.active_users).toBe(3);
  });

  it("honors the reference time (`now`)", async () => {
    // Seen from 10 days ago, the window is (24d, 10d] ago: only Alice's 20d
    // capture falls in it; bob's 6d capture is in that reference's future.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    const inputs = await collectAlphaBarInputs(db, {
      days: 14,
      now: tenDaysAgo,
      userIds: scope(),
    });
    expect(inputs.window_captures).toBe(1);
    expect(inputs.active_users).toBe(1);
  });

  it("evaluates to a verdict and carries no captured content", async () => {
    const bar = await computeAlphaBar(db, { days: 14, userIds: scope() });
    // 2 active users is far from 25 → the bar is not met; small samples are
    // reported as insufficient rather than passing.
    expect(bar.verdict).toBe("not_met");
    expect(bar.metrics.active_users).toMatchObject({ value: 2, status: "fail" });
    // 1 of 5 window captures is in a real project: 0.2 is not > 0.4.
    expect(bar.metrics.linked_share).toMatchObject({ value: 0.2, status: "fail", sample: 5 });
    expect(bar.metrics.capture_to_action_p75_seconds.status).toBe("insufficient_data");
    expect(bar.intent_split.retrieval).toBe("not_instrumented");
    const text = JSON.stringify(bar);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("pricing page");
    expect(text).not.toContain(alice.userId);
  });

  it("counts an approval as confirmation even while queued or after a failed execution", async () => {
    // Tier-1 approval sets status 'queued' (routes-m2); the worker may later
    // mark it 'failed'. Either way the user confirmed — execution outcome is
    // not part of capture-to-confirmed. A still-proposed action is not.
    const daveId = await seedUser(`alpha-bar-dave-${stamp}@example.test`, 3);
    try {
      const moments = [
        await seedMoment(daveId, 1),
        await seedMoment(daveId, 1),
        await seedMoment(daveId, 1),
      ];
      await db.query(
        `INSERT INTO actions (user_id, moment_id, action_type, risk_tier, status, payload,
                              approved_by, approved_at)
         SELECT $1, m.id, 'notion_page', 1, s.status::action_status, '{}',
                CASE WHEN s.secs IS NULL THEN NULL ELSE $1::uuid END,
                m.created_at + make_interval(secs => s.secs)
         FROM context_moments m
         JOIN (VALUES ($2::uuid, 'queued', 5), ($3::uuid, 'failed', 7), ($4::uuid, 'proposed', NULL))
           AS s(moment_id, status, secs) ON s.moment_id = m.id`,
        [daveId, ...moments],
      );
      const inputs = await collectAlphaBarInputs(db, { days: 14, userIds: [daveId] });
      expect(inputs.confirmed_actions).toBe(2);
      expect(inputs.captures_without_intent).toBe(3);
      expect(inputs.captures_without_intent_actioned).toBe(2);
      expect(inputs.capture_to_action_p75_seconds!).toBeCloseTo(6.5, 1);
    } finally {
      await db.query(`DELETE FROM users WHERE id = $1`, [daveId]);
    }
  });

  it("is part of the ops:report output", async () => {
    const report = await runAlphaReport(db, { days: 14 });
    expect(report.alpha_bar.window_days).toBe(14);
    expect(Object.keys(report.alpha_bar.metrics).sort()).toEqual([
      "active_users",
      "capture_to_action_p75_seconds",
      "captures_per_user_per_week",
      "linked_share",
      "week4_retention",
    ]);
    expect(JSON.stringify(report.alpha_bar)).not.toContain(SECRET_TEXT);
  });
});
