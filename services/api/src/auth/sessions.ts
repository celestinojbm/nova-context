import { createHash, randomBytes, randomInt } from "node:crypto";
import type pg from "pg";

/**
 * Opaque server-side sessions. The client holds a random 256-bit token; the
 * database stores only its SHA-256, so neither a DB dump nor a log line
 * yields a usable credential. Tokens are prefixed by audience so a leaked
 * value is identifiable (and greppable) without being guessable.
 */

export type SessionKind = "web" | "extension";

export interface AuthContext {
  userId: string;
  sessionId: string;
  kind: SessionKind;
  email: string;
}

const TOKEN_PREFIX: Record<SessionKind, string> = {
  web: "nova_sess_",
  extension: "nova_ext_",
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newSessionToken(kind: SessionKind): string {
  return TOKEN_PREFIX[kind] + randomBytes(32).toString("base64url");
}

export async function createSession(
  db: pg.Pool,
  input: {
    userId: string;
    kind: SessionKind;
    ttlHours: number;
    label?: string | null;
  },
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const token = newSessionToken(input.kind);
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, kind, expires_at, label)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
     RETURNING id, expires_at`,
    [input.userId, sha256Hex(token), input.kind, String(input.ttlHours), input.label ?? null],
  );
  return {
    token,
    sessionId: rows[0]!.id,
    expiresAt: rows[0]!.expires_at.toISOString(),
  };
}

/** Resolve a bearer token to a live session, or null (expired/revoked/unknown). */
export async function resolveSession(
  db: pg.Pool,
  token: string,
): Promise<AuthContext | null> {
  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    kind: SessionKind;
    email: string;
  }>(
    `UPDATE sessions s SET last_used_at = now()
     FROM users u
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.id = s.user_id
       AND u.deleted_at IS NULL
     RETURNING s.id AS session_id, s.user_id, s.kind, u.email`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    kind: row.kind,
    email: row.email,
  };
}

export async function revokeSession(db: pg.Pool, sessionId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Pairing codes: 8 digits, single-use, 10-minute lifetime, minted by an
 * authenticated web session and claimed by the extension. */
const PAIRING_TTL_MINUTES = 10;

export async function createPairingCode(
  db: pg.Pool,
  userId: string,
): Promise<{ code: string; expiresAt: string }> {
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO pairing_codes (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + interval '${PAIRING_TTL_MINUTES} minutes')
     RETURNING expires_at`,
    [userId, sha256Hex(code)],
  );
  return { code, expiresAt: rows[0]!.expires_at.toISOString() };
}

/** Claim atomically: a code works exactly once, and only before expiry. */
export async function claimPairingCode(
  db: pg.Pool,
  code: string,
): Promise<{ userId: string } | null> {
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE pairing_codes SET claimed_at = now()
     WHERE code_hash = $1 AND claimed_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256Hex(code)],
  );
  return rows[0] ? { userId: rows[0].user_id } : null;
}
