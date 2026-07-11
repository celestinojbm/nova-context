import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { FsObjectStore } from "../../src/media/object-store.js";
import { runMaintenance } from "../../src/ops/maintenance.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M11 suite: operations surface — health/readiness, the authenticated
 * status endpoint, maintenance dry-run vs apply, and log hygiene (no
 * captured content or credentials in structured logs).
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const KEY_HEX = randomBytes(32).toString("hex");

describe.skipIf(!databaseUrl)("M11: ops surface", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let user: TestUser;
  let fsRoot: string;
  let store: FsObjectStore;
  const logLines: string[] = [];

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-ops-test-${Date.now()}`);
    store = new FsObjectStore(fsRoot);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
        NOVA_GIT_SHA: "test-sha-123",
        NOVA_RATE_LIMIT_PREFIX: `test-rl-ops-${Date.now()}`,
      }),
      ocr: null,
      objectStore: store,
      loggerStream: { write: (msg: string) => void logLines.push(msg) },
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    user = await createUser(app, `ops-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("/healthz is a public liveness check", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("/readyz reports every component and overall readiness", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.migrations.ok).toBe(true); // all applied
    expect(body.checks.redis.ok).toBe(true);
    expect(body.checks.media_store.ok).toBe(true); // write/read/delete probe
  });

  it("/readyz (public) exposes ONLY booleans — no internal error/detail leak (M15 P3)", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    const body = res.json();
    // Every component is a bare {ok:boolean} — no 'error', no 'detail'.
    for (const check of Object.values(body.checks) as Record<string, unknown>[]) {
      expect(Object.keys(check)).toEqual(["ok"]);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("error");
    expect(raw).not.toContain("detail");
    expect(raw).not.toContain(fsRoot); // no paths
    expect(raw).not.toContain("5432"); // no ports/hosts
    expect(raw).not.toContain("6379");
  });

  it("/v1/ops/status requires auth and returns counts only", async () => {
    const anon = await app.inject({ method: "GET", url: "/v1/ops/status" });
    expect(anon.statusCode).toBe(401);

    const res = await user.inject({ method: "GET", url: "/v1/ops/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.version).toBe("test-sha-123");
    expect(typeof body.totals.media_objects).toBe("number");
    expect(typeof body.totals.pending_media_deletes).toBe("number");
    expect(typeof body.totals.failed_actions).toBe("number");
    if (redisUrl) {
      expect(body.queues.enrichment).toBeTruthy();
      expect(body.queues.actions).toBeTruthy();
    }
    // M15 (Hermes P2): rate-limiter backend + degraded state are surfaced.
    expect(body.rate_limit).toBeTruthy();
    expect(["redis", "memory"]).toContain(body.rate_limit.backend);
    expect(body.rate_limit.degraded).toBe(false); // healthy Redis in this suite
    // Counts and booleans only: no storage keys, no content markers.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("data:image");
    expect(raw).not.toContain(fsRoot);
    expect(raw).not.toContain(KEY_HEX);
  });

  it("maintenance: dry-run counts but deletes nothing; apply cleans up", async () => {
    // Seed obviously-dead rows: an expired session, an expired pairing
    // code, an expired oauth state, an expired password reset.
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, kind, expires_at, revoked_at, last_used_at)
       VALUES ($1, $2, 'web', now() - interval '30 days', now() - interval '30 days', now() - interval '30 days')`,
      [user.userId, `stale-${Date.now()}`],
    );
    await db.query(
      `INSERT INTO pairing_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 day')`,
      [user.userId, `stale-code-${Date.now()}`],
    );
    await db.query(
      `INSERT INTO oauth_states (user_id, provider, state_hash, expires_at)
       VALUES ($1, 'notion', $2, now() - interval '1 day')`,
      [user.userId, `stale-state-${Date.now()}`],
    );
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 day')`,
      [user.userId, `stale-reset-${Date.now()}`],
    );

    const dry = await runMaintenance(db, store, { apply: false });
    expect(dry.mode).toBe("dry-run");
    const staleDry = dry.stale_sessions as { count: number; deleted: number };
    expect(staleDry.count).toBeGreaterThanOrEqual(1);
    expect(staleDry.deleted).toBe(0);
    // Dry run really deleted nothing.
    const still = await db.query(
      `SELECT count(*) AS n FROM pairing_codes WHERE expires_at < now()`,
    );
    expect(Number(still.rows[0].n)).toBeGreaterThanOrEqual(1);

    const applied = await runMaintenance(db, store, { apply: true });
    expect(applied.mode).toBe("apply");
    expect((applied.stale_sessions as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    expect((applied.expired_pairing_codes as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    expect((applied.expired_oauth_states as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    expect((applied.expired_password_resets as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);

    // Product events are untouched without an explicit prune window.
    expect((applied.product_events as { deleted: number }).deleted).toBe(0);

    // Both runs recorded; the status endpoint shows the latest.
    const runs = await db.query(`SELECT mode FROM ops_maintenance_runs ORDER BY ran_at DESC LIMIT 2`);
    expect(runs.rows.map((r) => r.mode)).toEqual(["apply", "dry-run"]);
    const status = await user.inject({ method: "GET", url: "/v1/ops/status" });
    expect(status.json().last_maintenance.mode).toBe("apply");
  });

  it("responses carry a correlation id; incoming x-request-id is honored", async () => {
    const res = await user.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { "x-request-id": "corr-abc-123" },
    });
    expect(res.headers["x-request-id"]).toBe("corr-abc-123");
    const minted = await user.inject({ method: "GET", url: "/v1/auth/me" });
    expect(typeof minted.headers["x-request-id"]).toBe("string");
    expect((minted.headers["x-request-id"] as string).length).toBeGreaterThan(0);
  });

  it("structured logs never contain captured content, passwords, or tokens", async () => {
    logLines.length = 0;
    const SECRET_TEXT = "hyper-secret-captured-paragraph-zzz";
    const capture = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://logs.example.com/x", title: "Log Hygiene" },
        payload: { dom_extract: { main_text: SECRET_TEXT } },
        extracted_text: SECRET_TEXT,
        intent_text: "remember " + SECRET_TEXT,
      },
    });
    expect(capture.statusCode).toBe(201);
    // Also exercise a failed login (security event log line).
    await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "wrong-password-abc" },
    });

    const joined = logLines.join("\n");
    expect(joined.length).toBeGreaterThan(0); // logs actually flowed
    expect(joined).toContain("login_failed"); // security event present
    expect(joined).not.toContain(SECRET_TEXT); // captured content absent
    expect(joined).not.toContain("wrong-password-abc"); // credentials absent
    expect(joined).not.toContain(user.token); // session token absent
    expect(joined).not.toContain(KEY_HEX); // encryption key absent
  });
});
