import type { FastifyInstance } from "fastify";
import pg from "pg";
import { hashPassword } from "../../src/auth/passwords.js";

/**
 * M5 test helpers. Integration suites exercise real auth end to end: the
 * M0–M4 regression files sign in as the seeded dev user (so their data
 * assumptions keep holding), and the auth/isolation suites create fresh
 * accounts through the public signup endpoint.
 */

export const DEV_EMAIL = "dev@nova.local";
export const DEV_PASSWORD = "nova-dev-password";

export interface InjectOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

export type AuthedInject = (
  opts: InjectOptions,
) => ReturnType<FastifyInstance["inject"]>;

export function authedInject(app: FastifyInstance, token: string): AuthedInject {
  return (opts) =>
    app.inject({
      ...opts,
      headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
    } as Parameters<FastifyInstance["inject"]>[0]) as ReturnType<
      FastifyInstance["inject"]
    >;
}

export interface TestUser {
  token: string;
  userId: string;
  email: string;
  inject: AuthedInject;
}

/** Give the seeded dev user a password (idempotent) and sign in. */
export async function loginAsDevUser(
  app: FastifyInstance,
  databaseUrl: string,
): Promise<TestUser> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let userId: string;
  try {
    const hash = await hashPassword(DEV_PASSWORD);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id`,
      [hash, DEV_EMAIL],
    );
    if (!rows[0]) {
      throw new Error(`${DEV_EMAIL} missing — did migrations run?`);
    }
    userId = rows[0].id;
  } finally {
    await client.end();
  }
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: DEV_EMAIL, password: DEV_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`dev login failed: ${res.statusCode} ${res.body}`);
  }
  const { token } = res.json() as { token: string };
  return { token, userId, email: DEV_EMAIL, inject: authedInject(app, token) };
}

/** Create (or reuse) an account through the public signup endpoint. */
export async function createUser(
  app: FastifyInstance,
  email: string,
  password = "integration-test-password",
): Promise<TestUser> {
  let res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password },
  });
  if (res.statusCode === 409) {
    res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
  }
  if (res.statusCode !== 201 && res.statusCode !== 200) {
    throw new Error(`signup/login for ${email} failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { token: string; user: { id: string } };
  return {
    token: body.token,
    userId: body.user.id,
    email,
    inject: authedInject(app, body.token),
  };
}
