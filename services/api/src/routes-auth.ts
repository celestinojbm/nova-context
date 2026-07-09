import {
  loginRequestSchema,
  pairingClaimRequestSchema,
  signupRequestSchema,
  type CreateSessionResponse,
  type ListSessionsResponse,
  type MeResponse,
  type PairingCodeResponse,
} from "@nova/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Env } from "./env.js";
import { hashPassword, verifyPassword } from "./auth/passwords.js";
import { requireAuth } from "./auth/plugin.js";
import {
  claimPairingCode,
  createPairingCode,
  createSession,
  revokeSession,
} from "./auth/sessions.js";

export interface AuthRouteDeps {
  db: pg.Pool;
  env: Env;
}

/**
 * Fixed-window in-memory limiter for the credential-guessing surfaces
 * (login, signup, pairing claim). Per-process only — good enough for a
 * single-instance private alpha; move to Redis if the API scales out.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 30;

function makeRateLimiter() {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_ATTEMPTS;
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, env } = deps;
  const allowAttempt = makeRateLimiter();

  function sessionLabel(req: FastifyRequest): string | null {
    const ua = req.headers["user-agent"];
    return typeof ua === "string" ? ua.slice(0, 120) : null;
  }

  async function audit(userId: string, eventType: string, detail: Record<string, unknown>) {
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, detail) VALUES ($1, $2, $3)`,
      [userId, eventType, JSON.stringify(detail)],
    );
  }

  app.post("/v1/auth/signup", async (req, reply) => {
    if (env.signupMode === "closed") {
      return reply.code(403).send({ error: "signup_closed" });
    }
    const parsed = signupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    if (!allowAttempt(`signup:${req.ip}`)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    if (env.signupMode === "invite") {
      // Missing code in production config ⇒ nothing matches ⇒ fail closed.
      if (!env.NOVA_ALPHA_INVITE_CODE || parsed.data.invite_code !== env.NOVA_ALPHA_INVITE_CODE) {
        return reply.code(403).send({ error: "invalid_invite_code" });
      }
    }

    const passwordHash = await hashPassword(parsed.data.password);
    let userId: string;
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO users (email, display_name, password_hash)
         VALUES ($1, $2, $3) RETURNING id`,
        [parsed.data.email, parsed.data.display_name ?? null, passwordHash],
      );
      userId = rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "email_taken" });
      }
      throw err;
    }
    // Every account starts with the same default project the dev seed used.
    await db.query(
      `INSERT INTO projects (user_id, name, description)
       VALUES ($1, 'Inbox', 'Default project for unsorted context moments')`,
      [userId],
    );
    const session = await createSession(db, {
      userId,
      kind: "web",
      ttlHours: env.NOVA_SESSION_TTL_HOURS,
      label: sessionLabel(req),
    });
    await audit(userId, "auth.signup", { mode: env.signupMode });
    const response: CreateSessionResponse = {
      token: session.token,
      expires_at: session.expiresAt,
      user: {
        id: userId,
        email: parsed.data.email,
        display_name: parsed.data.display_name ?? null,
      },
    };
    return reply.code(201).send(response);
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const parsed = loginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!allowAttempt(`login:${req.ip}`)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const { rows } = await db.query<{
      id: string;
      email: string;
      display_name: string | null;
      password_hash: string | null;
    }>(
      `SELECT id, email, display_name, password_hash FROM users
       WHERE email = $1 AND deleted_at IS NULL`,
      [parsed.data.email],
    );
    const user = rows[0];
    // Verify against a real hash even when the user is unknown, so response
    // timing does not reveal which emails exist.
    const ok = user
      ? await verifyPassword(parsed.data.password, user.password_hash)
      : await verifyPassword(parsed.data.password, DUMMY_HASH).then(() => false);
    if (!user || !ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const session = await createSession(db, {
      userId: user.id,
      kind: "web",
      ttlHours: env.NOVA_SESSION_TTL_HOURS,
      label: sessionLabel(req),
    });
    await audit(user.id, "auth.login", { kind: "web" });
    const response: CreateSessionResponse = {
      token: session.token,
      expires_at: session.expiresAt,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    };
    return response;
  });

  app.post("/v1/auth/logout", async (req) => {
    const auth = requireAuth(req);
    await revokeSession(db, auth.sessionId, auth.userId);
    await audit(auth.userId, "auth.logout", { kind: auth.kind });
    return { ok: true };
  });

  app.get("/v1/auth/me", async (req, reply) => {
    const auth = requireAuth(req);
    const { rows } = await db.query<{
      email: string;
      display_name: string | null;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT u.email, u.display_name, s.created_at, s.expires_at
       FROM users u JOIN sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND s.id = $2`,
      [auth.userId, auth.sessionId],
    );
    const row = rows[0];
    if (!row) return reply.code(401).send({ error: "unauthorized" });
    const response: MeResponse = {
      user: { id: auth.userId, email: row.email, display_name: row.display_name },
      session: {
        id: auth.sessionId,
        kind: auth.kind,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
      },
    };
    return response;
  });

  /** Minted from a signed-in WEB session only: an extension token must not
   * be able to breed further credentials. */
  app.post("/v1/auth/pairing-codes", async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.kind !== "web") {
      return reply.code(403).send({ error: "web_session_required" });
    }
    const { code, expiresAt } = await createPairingCode(db, auth.userId);
    const response: PairingCodeResponse = { code, expires_at: expiresAt };
    return reply.code(201).send(response);
  });

  app.post("/v1/auth/pairing/claim", async (req, reply) => {
    const parsed = pairingClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!allowAttempt(`pair:${req.ip}`)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const claimed = await claimPairingCode(db, parsed.data.code);
    if (!claimed) {
      return reply.code(401).send({ error: "invalid_or_expired_code" });
    }
    const { rows } = await db.query<{ email: string; display_name: string | null }>(
      `SELECT email, display_name FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [claimed.userId],
    );
    const user = rows[0];
    if (!user) return reply.code(401).send({ error: "invalid_or_expired_code" });
    const session = await createSession(db, {
      userId: claimed.userId,
      kind: "extension",
      ttlHours: env.NOVA_EXTENSION_SESSION_TTL_HOURS,
      label: "browser extension",
    });
    await audit(claimed.userId, "auth.extension.paired", {});
    const response: CreateSessionResponse = {
      token: session.token,
      expires_at: session.expiresAt,
      user: { id: claimed.userId, email: user.email, display_name: user.display_name },
    };
    return reply.code(201).send(response);
  });

  app.get("/v1/auth/sessions", async (req) => {
    const auth = requireAuth(req);
    const { rows } = await db.query(
      `SELECT id, kind, label, created_at, last_used_at, expires_at
       FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [auth.userId],
    );
    const response: ListSessionsResponse = {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
        current: r.id === auth.sessionId,
      })),
    };
    return response;
  });

  app.delete("/v1/auth/sessions/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const auth = requireAuth(req);
    const revoked = await revokeSession(db, params.data.id, auth.userId);
    if (!revoked) return reply.code(404).send({ error: "not_found" });
    await audit(auth.userId, "auth.session.revoke", {
      self: params.data.id === auth.sessionId,
    });
    return { revoked: true };
  });
}

/** Pre-computed scrypt hash of an unguessable value; used to equalize login
 * timing for unknown emails. */
const DUMMY_HASH =
  "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
