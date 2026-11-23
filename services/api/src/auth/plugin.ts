import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { resolveSession, type AuthContext } from "./sessions.js";
import { resolveNamespaceToken } from "../memory/token-auth.js";
import { isNamespaceToken, tokenRouteAllowed, type NamespaceTokenContext } from "../memory/tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** M20b: set instead of `auth` when the bearer is a namespace token. */
    nsToken: NamespaceTokenContext | null;
  }
}

/**
 * Centralized authorization (M5). Everything under /v1 requires a valid
 * session token except the explicit allowlist below — new routes are
 * protected by default (fail closed). Unauthenticated → 401. Ownership
 * checks stay in each route's SQL (user_id = $auth), which returns 404 for
 * other users' resources so existence never leaks.
 *
 * The API accepts ONE credential shape: `Authorization: Bearer <token>`.
 * The web app keeps the token in an HttpOnly cookie on ITS origin and
 * forwards it server-side; the extension holds a device token from the
 * pairing flow. No cookie is ever read here, so cross-site request forgery
 * against the API has no ambient credential to ride on.
 */
const PUBLIC_V1_ROUTES = new Set([
  "POST /v1/auth/signup",
  "POST /v1/auth/login",
  "POST /v1/auth/pairing/claim",
  // M11 password reset: both legs are pre-auth by nature and rate-limited.
  "POST /v1/auth/password-reset/request",
  "POST /v1/auth/password-reset/confirm",
]);

export function registerAuth(app: FastifyInstance, db: pg.Pool): void {
  app.decorateRequest("auth", null);
  app.decorateRequest("nsToken", null);

  app.addHook("onRequest", async (req, reply) => {
    req.auth = null;
    req.nsToken = null;
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/v1/")) return; // only /healthz lives outside /v1
    if (PUBLIC_V1_ROUTES.has(`${req.method} ${path}`)) return;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const bearer = header.slice("Bearer ".length).trim();
    // M20b §2.4: a namespace token never reaches account surfaces (moments,
    // projects, other namespaces…): 404, not 403, so existence never leaks.
    if (isNamespaceToken(bearer)) {
      if (!tokenRouteAllowed(req.method, path)) return reply.code(404).send({ error: "not_found" });
      const r = await resolveNamespaceToken(db, bearer);
      if (!r.ok) return reply.code(r.status).send({ error: r.status === 429 ? "rate_limited" : "unauthorized", reason: r.reason });
      req.nsToken = r.ctx;
      return;
    }
    const auth = await resolveSession(db, bearer);
    if (!auth) {
      return reply.code(401).send({ error: "unauthorized", reason: "session_invalid_or_expired" });
    }
    req.auth = auth;
  });
}

/** For protected routes: the hook guarantees auth is set; make that explicit. */
export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) {
    throw Object.assign(new Error("route reached without auth context"), {
      statusCode: 500,
    });
  }
  return req.auth;
}
