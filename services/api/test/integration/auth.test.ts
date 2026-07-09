import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { authedInject, createUser } from "./helpers.js";

/**
 * M5 auth suite: session lifecycle (signup/login/logout), fail-closed
 * middleware, expiry/revocation, signup policy, and the extension pairing
 * flow. Everything runs against real Postgres.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("M5: authentication", () => {
  let app: FastifyInstance;
  let db: pg.Client;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({ env: loadEnv({ DATABASE_URL: databaseUrl }) });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  const PROTECTED_ROUTES: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string }> = [
    { method: "GET", url: "/v1/context/moments" },
    { method: "POST", url: "/v1/context/moments" },
    { method: "GET", url: "/v1/context/moments/00000000-0000-4000-8000-000000000000" },
    { method: "DELETE", url: "/v1/context/moments/00000000-0000-4000-8000-000000000000" },
    { method: "GET", url: "/v1/projects" },
    { method: "GET", url: "/v1/projects/00000000-0000-4000-8000-000000000000" },
    { method: "DELETE", url: "/v1/projects/00000000-0000-4000-8000-000000000000" },
    { method: "POST", url: "/v1/projects/suggest" },
    { method: "GET", url: "/v1/tasks" },
    { method: "PATCH", url: "/v1/tasks/00000000-0000-4000-8000-000000000000" },
    { method: "POST", url: "/v1/memory/search" },
    { method: "GET", url: "/v1/actions" },
    { method: "POST", url: "/v1/actions/00000000-0000-4000-8000-000000000000/approve" },
    { method: "POST", url: "/v1/actions/00000000-0000-4000-8000-000000000000/reject" },
    { method: "POST", url: "/v1/live/answers" },
    { method: "GET", url: "/v1/export" },
    { method: "GET", url: "/v1/audit" },
    { method: "POST", url: "/v1/events" },
    { method: "POST", url: "/v1/transcriptions" },
    { method: "GET", url: "/v1/auth/me" },
    { method: "GET", url: "/v1/auth/sessions" },
    { method: "POST", url: "/v1/auth/pairing-codes" },
    { method: "POST", url: "/v1/auth/logout" },
  ];

  it("rejects every protected route without credentials (fail closed)", async () => {
    for (const route of PROTECTED_ROUTES) {
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("rejects garbage bearer tokens", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/context/moments",
      headers: { authorization: "Bearer nova_sess_not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("keeps /healthz public", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("signs up, returns a working session, and seeds an Inbox project", async () => {
    const email = `alice-${Date.now()}@test.local`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email, password: "a-long-password-1", display_name: "Alice" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^nova_sess_/);
    expect(body.user.email).toBe(email);

    const inject = authedInject(app, body.token);
    const me = await inject({ method: "GET", url: "/v1/auth/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
    expect(me.json().session.kind).toBe("web");

    const projects = await inject({ method: "GET", url: "/v1/projects" });
    expect(projects.json().items.map((p: { name: string }) => p.name)).toContain("Inbox");
  });

  it("rejects duplicate signup with 409 and weak passwords with 400", async () => {
    const user = await createUser(app, `dup-${Date.now()}@test.local`);
    const dup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: user.email, password: "another-long-password" },
    });
    expect(dup.statusCode).toBe(409);

    const weak = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: `weak-${Date.now()}@test.local`, password: "short" },
    });
    expect(weak.statusCode).toBe(400);
  });

  it("rejects wrong passwords and unknown emails identically (401)", async () => {
    const user = await createUser(app, `carol-${Date.now()}@test.local`);
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "not-the-password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("invalid_credentials");

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: `ghost-${Date.now()}@test.local`, password: "whatever-long" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe("invalid_credentials");
  });

  it("logout revokes the session immediately", async () => {
    const user = await createUser(app, `dave-${Date.now()}@test.local`);
    const out = await user.inject({ method: "POST", url: "/v1/auth/logout" });
    expect(out.statusCode).toBe(200);
    const me = await user.inject({ method: "GET", url: "/v1/auth/me" });
    expect(me.statusCode).toBe(401);
  });

  it("rejects expired sessions", async () => {
    const user = await createUser(app, `evan-${Date.now()}@test.local`);
    await db.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
       WHERE user_id = $1`,
      [user.userId],
    );
    const res = await user.inject({ method: "GET", url: "/v1/context/moments" });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("session_invalid_or_expired");
  });

  it("lists sessions and revokes a chosen one", async () => {
    const email = `fay-${Date.now()}@test.local`;
    const first = await createUser(app, email);
    // Second session for the same account.
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "integration-test-password" },
    });
    const second = authedInject(app, login.json().token);

    const list = await first.inject({ method: "GET", url: "/v1/auth/sessions" });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(2);
    const other = list.json().items.find((s: { current: boolean }) => !s.current);

    const revoke = await first.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${other.id}`,
    });
    expect(revoke.statusCode).toBe(200);
    const dead = await second({ method: "GET", url: "/v1/auth/me" });
    expect(dead.statusCode).toBe(401);
  });

  it("pairing: web session mints a code, extension claims it exactly once", async () => {
    const user = await createUser(app, `pair-${Date.now()}@test.local`);
    const minted = await user.inject({ method: "POST", url: "/v1/auth/pairing-codes" });
    expect(minted.statusCode).toBe(201);
    const { code } = minted.json();
    expect(code).toMatch(/^\d{8}$/);

    const claim = await app.inject({
      method: "POST",
      url: "/v1/auth/pairing/claim",
      payload: { code },
    });
    expect(claim.statusCode).toBe(201);
    const ext = claim.json();
    expect(ext.token).toMatch(/^nova_ext_/);
    expect(ext.user.email).toBe(user.email);

    // The extension token authenticates capture-shaped requests…
    const extInject = authedInject(app, ext.token);
    const list = await extInject({ method: "GET", url: "/v1/projects" });
    expect(list.statusCode).toBe(200);

    // …but cannot mint further pairing codes.
    const escalate = await extInject({ method: "POST", url: "/v1/auth/pairing-codes" });
    expect(escalate.statusCode).toBe(403);

    // Codes are single-use.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/pairing/claim",
      payload: { code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("pairing codes expire", async () => {
    const user = await createUser(app, `pair2-${Date.now()}@test.local`);
    const minted = await user.inject({ method: "POST", url: "/v1/auth/pairing-codes" });
    const { code } = minted.json();
    await db.query(
      `UPDATE pairing_codes SET expires_at = now() - interval '1 minute'
       WHERE user_id = $1`,
      [user.userId],
    );
    const claim = await app.inject({
      method: "POST",
      url: "/v1/auth/pairing/claim",
      payload: { code },
    });
    expect(claim.statusCode).toBe(401);
  });

  it("enforces the signup policy (invite and closed modes)", async () => {
    const inviteApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_SIGNUP: "invite",
        NOVA_ALPHA_INVITE_CODE: "alpha-code-123",
      }),
    });
    await inviteApp.ready();
    try {
      const noCode = await inviteApp.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: `inv-${Date.now()}@test.local`, password: "a-long-password-1" },
      });
      expect(noCode.statusCode).toBe(403);
      const badCode = await inviteApp.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: {
          email: `inv-${Date.now()}@test.local`,
          password: "a-long-password-1",
          invite_code: "wrong",
        },
      });
      expect(badCode.statusCode).toBe(403);
      const good = await inviteApp.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: {
          email: `inv-ok-${Date.now()}@test.local`,
          password: "a-long-password-1",
          invite_code: "alpha-code-123",
        },
      });
      expect(good.statusCode).toBe(201);
    } finally {
      await inviteApp.close();
    }

    const closedApp = await buildApp({
      env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_SIGNUP: "closed" }),
    });
    await closedApp.ready();
    try {
      const res = await closedApp.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: `closed-${Date.now()}@test.local`, password: "a-long-password-1" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("signup_closed");
    } finally {
      await closedApp.close();
    }
  });

  it("audits auth events without secrets", async () => {
    const user = await createUser(app, `audit-${Date.now()}@test.local`);
    const { rows } = await db.query(
      `SELECT event_type, detail FROM audit_log WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.userId],
    );
    expect(rows.map((r) => r.event_type)).toContain("auth.signup");
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("integration-test-password");
    expect(serialized).not.toContain(user.token);
  });
});
