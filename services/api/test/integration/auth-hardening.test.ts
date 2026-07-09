import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { authedInject, createUser } from "./helpers.js";

/**
 * M7 auth hardening: password change (revokes other sessions), revoke-all,
 * and Redis-backed rate limiting shared across app instances.
 */
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!databaseUrl)("M7: auth hardening", () => {
  let app: FastifyInstance;
  let db: pg.Client;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({ DATABASE_URL: databaseUrl }),
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it("changes the password, revokes every other session, and old credentials die", async () => {
    const email = `pw-${Date.now()}@test.local`;
    const user = await createUser(app, email);
    // A second session (another device) + an extension session via pairing.
    const second = authedInject(
      app,
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/login",
          payload: { email, password: "integration-test-password" },
        })
      ).json().token,
    );
    const code = (
      await user.inject({ method: "POST", url: "/v1/auth/pairing-codes" })
    ).json().code;
    const ext = authedInject(
      app,
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/pairing/claim",
          payload: { code },
        })
      ).json().token,
    );

    // Wrong current password → 401, nothing changes.
    const wrong = await user.inject({
      method: "POST",
      url: "/v1/auth/password",
      payload: { current_password: "not-it", new_password: "a-brand-new-password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect((await second({ method: "GET", url: "/v1/auth/me" })).statusCode).toBe(200);

    // Correct change → other sessions (web + extension) are revoked.
    const changed = await user.inject({
      method: "POST",
      url: "/v1/auth/password",
      payload: {
        current_password: "integration-test-password",
        new_password: "a-brand-new-password",
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().revoked_sessions).toBeGreaterThanOrEqual(2);

    expect((await second({ method: "GET", url: "/v1/auth/me" })).statusCode).toBe(401);
    expect((await ext({ method: "GET", url: "/v1/projects" })).statusCode).toBe(401);
    // The changing session survives.
    expect((await user.inject({ method: "GET", url: "/v1/auth/me" })).statusCode).toBe(200);

    // Old password no longer signs in; the new one does.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "integration-test-password" },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "a-brand-new-password" },
    });
    expect(newLogin.statusCode).toBe(200);

    // Audit: event without any password material.
    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type = 'auth.password.change'`,
      [user.userId],
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain("a-brand-new-password");
  });

  it("extension sessions cannot change the password", async () => {
    const user = await createUser(app, `pw-ext-${Date.now()}@test.local`);
    const code = (
      await user.inject({ method: "POST", url: "/v1/auth/pairing-codes" })
    ).json().code;
    const extToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/pairing/claim",
        payload: { code },
      })
    ).json().token;
    const res = await authedInject(app, extToken)({
      method: "POST",
      url: "/v1/auth/password",
      payload: {
        current_password: "integration-test-password",
        new_password: "a-brand-new-password",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("revoke-all signs out every other session but keeps the current one", async () => {
    const email = `ra-${Date.now()}@test.local`;
    const user = await createUser(app, email);
    const others = [];
    for (let i = 0; i < 2; i++) {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email, password: "integration-test-password" },
      });
      others.push(authedInject(app, login.json().token));
    }
    const res = await user.inject({ method: "POST", url: "/v1/auth/sessions/revoke-all" });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(2);
    for (const other of others) {
      expect((await other({ method: "GET", url: "/v1/auth/me" })).statusCode).toBe(401);
    }
    expect((await user.inject({ method: "GET", url: "/v1/auth/me" })).statusCode).toBe(200);
  });

  describe.skipIf(!redisUrl)("redis-backed rate limiting", () => {
    it("shares the window across app instances and returns 429 past the limit", async () => {
      const prefix = `test-rl-hard-${Date.now()}`;
      const makeEnv = () =>
        loadEnv({
          DATABASE_URL: databaseUrl,
          REDIS_URL: redisUrl,
          NOVA_RATE_LIMIT_MAX: "5",
          NOVA_RATE_LIMIT_PREFIX: prefix,
        });
      const appA = await buildApp({ ocr: null, env: makeEnv() });
      const appB = await buildApp({ ocr: null, env: makeEnv() });
      await appA.ready();
      await appB.ready();
      try {
        const attempt = (instance: FastifyInstance) =>
          instance.inject({
            method: "POST",
            url: "/v1/auth/login",
            payload: { email: "nobody@test.local", password: "wrong-password" },
          });
        // 3 attempts on A + 2 on B fill the shared window of 5…
        for (let i = 0; i < 3; i++) expect((await attempt(appA)).statusCode).toBe(401);
        for (let i = 0; i < 2; i++) expect((await attempt(appB)).statusCode).toBe(401);
        // …so the 6th, on EITHER instance, is rate limited.
        expect((await attempt(appA)).statusCode).toBe(429);
        expect((await attempt(appB)).statusCode).toBe(429);
      } finally {
        await appA.close();
        await appB.close();
      }
    });
  });
});
