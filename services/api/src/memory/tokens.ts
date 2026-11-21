import { randomBytes } from "node:crypto";

/** M20b §2.4: per-namespace tokens for connected assistants. */
export const NAMESPACE_TOKEN_PREFIX = "nvx_";
export const SCOPES = ["memory:read", "memory:write", "memory:export"] as const;
export type Scope = (typeof SCOPES)[number];

export function newNamespaceToken(): { token: string; prefix: string } {
  const token = NAMESPACE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, prefix: token.slice(0, 8) };
}

export function isNamespaceToken(bearer: string): boolean {
  return bearer.startsWith(NAMESPACE_TOKEN_PREFIX);
}

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}(\/[a-z0-9][a-z0-9_-]{0,39}){0,2}$/;

export interface NamespaceTokenContext {
  tokenId: string;
  userId: string;
  prefix: string;
  /** namespace_id → scopes */
  grants: Map<string, Set<Scope>>;
}

/** Routes a namespace token may reach at all (anything else → 404). */
export function tokenRouteAllowed(method: string, path: string): boolean {
  if (path.startsWith("/v1/namespaces/") && /\/memory(\/[0-9a-f-]{36})?$/.test(path)) {
    return method === "GET" || method === "POST" || method === "PATCH";
  }
  if (path.startsWith("/v1/export/namespace/") && path.endsWith(".md")) return method === "GET";
  return false;
}
