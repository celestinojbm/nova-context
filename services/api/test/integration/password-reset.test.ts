import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M11 suite: self-service password reset (operator-delivered token).
 * Lifecycle, single-use, expiry, session revocation, rate limiting, no
 * account enumeration, and no token leakage into audit or logs.
 */
const databaseUrl = process.env.DATABASE_URL;

const PASSWORD = "integration-test-password";

describe.skipIf(!databaseUrl)("M11: password reset", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const logLines: string[] = [];

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        NOVA_RATE_LIMIT_PREFIX: `test-rl-reset-${Date.now()}`,
      }),
      ocr: null,
      loggerStream: { write: (msg: string) => void logLines.push(msg) },
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  /** Operator leg: mint a token the way `auth:reset-token` does. */
  function mintToken(email: string): string {
    const out = execFileSync("pnpm", ["exec", "tsx", "src/db/reset-token.ts", "--", email], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    const match = out.match(/token=([\w.-]+)/);
    expect(match, "operator command printed a reset URL").toBeTruthy();
    return match![1]!;
  }

  it("request leg answers identically for existing and unknown accounts", async () => {
    const user = await createUser(app, `reset-a-${Date.now()}@test.local`);
    const real = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/request",
      payload: { email: user.email },
    });
    const fake = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/request",
      payload: { email: `nobody-${Date.now()}@test.local` },
    });
    expect(real.statusCode).toBe(202);
    expect(fake.statusCode).toBe(202);
    expect(real.json()).toEqual(fake.json()); // byte-identical bodies

    // A token WAS minted for the real account (hashed at rest, unaudited value).
    const rows = await db.query(
      `SELECT token_hash FROM password_resets WHERE user_id = $1`,
      [user.userId],
    );
    expect(rows.rows).toHaveLength(1);
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'auth.password.reset_requested'`,
      [user.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain(rows.rows[0].token_hash);
  });

  it("full lifecycle: operator token resets the password and revokes every session", async () => {
    const user = await createUser(app, `reset-b-${Date.now()}@test.local`);
    const token = mintToken(user.email);

    const confirm = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      payload: { token, new_password: "brand-new-password-42" },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().reset).toBe(true);

    // Every pre-existing session is dead.
    const me = await user.inject({ method: "GET", url: "/v1/auth/me" });
    expect(me.statusCode).toBe(401);

    // Old password fails, new one works.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "brand-new-password-42" },
    });
    expect(newLogin.statusCode).toBe(200);

    // Single use: the same token cannot fire twice.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      payload: { token, new_password: "yet-another-password-9" },
    });
    expect(replay.statusCode).toBe(400);

    // Audited without the token appearing anywhere.
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'auth.password.reset_completed'`,
      [user.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail.revoked_sessions).toBeGreaterThanOrEqual(1);
    const allAudit = await db.query(`SELECT detail FROM audit_log WHERE user_id = $1`, [
      user.userId,
    ]);
    expect(JSON.stringify(allAudit.rows)).not.toContain(token);
    // The token never reached the structured logs either.
    expect(logLines.join("\n")).not.toContain(token);
  });

  it("expired tokens are rejected and leave the password unchanged", async () => {
    const user = await createUser(app, `reset-c-${Date.now()}@test.local`);
    const token = mintToken(user.email);
    await db.query(
      `UPDATE password_resets SET expires_at = now() - interval '1 minute'
       WHERE user_id = $1`,
      [user.userId],
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      payload: { token, new_password: "should-not-take-effect" },
    });
    expect(res.statusCode).toBe(400);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200); // old password still valid
  });

  it("both legs are rate limited", async () => {
    const tight = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        NOVA_RATE_LIMIT_MAX: "1",
        NOVA_RATE_LIMIT_PREFIX: `test-rl-reset-tight-${Date.now()}`,
      }),
      ocr: null,
    });
    await tight.ready();
    try {
      const first = await tight.inject({
        method: "POST",
        url: "/v1/auth/password-reset/request",
        payload: { email: `rl-${Date.now()}@test.local` },
      });
      expect(first.statusCode).toBe(202);
      const second = await tight.inject({
        method: "POST",
        url: "/v1/auth/password-reset/request",
        payload: { email: `rl2-${Date.now()}@test.local` },
      });
      expect(second.statusCode).toBe(429);

      const confirm1 = await tight.inject({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        payload: { token: "nova_reset_bogus-token-value", new_password: "irrelevant-pass-1" },
      });
      expect(confirm1.statusCode).toBe(400); // consumed the only attempt
      const confirm2 = await tight.inject({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        payload: { token: "nova_reset_bogus-token-value", new_password: "irrelevant-pass-2" },
      });
      expect(confirm2.statusCode).toBe(429);
    } finally {
      await tight.close();
    }
  });
});
