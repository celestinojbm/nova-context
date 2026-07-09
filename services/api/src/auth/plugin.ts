import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { resolveSession, type AuthContext } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
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
]);

export function registerAuth(app: FastifyInstance, db: pg.Pool): void {
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (req, reply) => {
    req.auth = null;
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/v1/")) return; // only /healthz lives outside /v1
    if (PUBLIC_V1_ROUTES.has(`${req.method} ${path}`)) return;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const auth = await resolveSession(db, header.slice("Bearer ".length).trim());
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
