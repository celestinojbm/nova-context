import type pg from "pg";
import { sha256Hex } from "../auth/sessions.js";
import type { NamespaceTokenContext, Scope } from "./tokens.js";

export type TokenResolution =
  | { ok: true; ctx: NamespaceTokenContext }
  | { ok: false; status: 401 | 429; reason: string };

/**
 * Validate a namespace token against the DB on EVERY request (no cache), so
 * revocation is immediate (§2.4 allows ≤60 s; we do 0 s). The same UPDATE
 * enforces the per-token fixed hourly window atomically across instances and
 * bumps last_used_at.
 */
export async function resolveNamespaceToken(db: pg.Pool, token: string): Promise<TokenResolution> {
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    token_prefix: string;
    usage_count: number;
    rate_limit_per_hour: number;
  }>(
    `UPDATE namespace_tokens SET
       usage_count = CASE WHEN usage_window_start > now() - interval '1 hour' THEN usage_count + 1 ELSE 1 END,
       usage_window_start = CASE WHEN usage_window_start > now() - interval '1 hour' THEN usage_window_start ELSE now() END,
       last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, user_id, token_prefix, usage_count, rate_limit_per_hour`,
    [sha256Hex(token)],
  );
  const t = rows[0];
  if (!t) return { ok: false, status: 401, reason: "token_invalid_revoked_or_expired" };
  if (t.usage_count > t.rate_limit_per_hour) {
    return { ok: false, status: 429, reason: "token_rate_limited" };
  }
  const grants = await db.query<{ namespace_id: string; scopes: string[] }>(
    `SELECT g.namespace_id, g.scopes FROM namespace_token_grants g
     JOIN memory_namespaces n ON n.id = g.namespace_id
     WHERE g.token_id = $1 AND n.archived_at IS NULL`,
    [t.id],
  );
  return {
    ok: true,
    ctx: {
      tokenId: t.id,
      userId: t.user_id,
      prefix: t.token_prefix,
      grants: new Map(grants.rows.map((g) => [g.namespace_id, new Set(g.scopes as Scope[])])),
    },
  };
}
