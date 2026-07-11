/**
 * M15B (Hermes D03): restore-target classification + DSN redaction.
 *
 * `scripts/restore.sh` must NEVER print a raw DATABASE_URL (it can carry
 * credentials) and must not treat a real database as "local scratch" just
 * because its name contains a familiar string. Both concerns live here as a
 * pure, unit-tested function so the shell only consumes a safe verdict.
 */

/** Redact credentials from a DSN: scheme://***@host:port/db. Never returns
 * the username or password. Unparseable input → a stable placeholder. */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const auth = u.username ? "***@" : "";
    const host = u.hostname || "?";
    const port = u.port ? `:${u.port}` : "";
    const db = u.pathname.replace(/^\//, "") || "?";
    return `${u.protocol}//${auth}${host}${port}/${db}`;
  } catch {
    return "<unparseable-database-url>";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface RestoreTarget {
  redacted: string;
  /** True only for a clearly local scratch target (loopback host, non-prod). */
  local: boolean;
  /** True when the operator must pass the production override to proceed. */
  requiresOverride: boolean;
}

/**
 * Classify a restore target. Only a loopback host in a non-production
 * environment is "local" and may proceed on the typed confirmation alone.
 * ANY remote/non-loopback host — including a database literally named
 * `nova_alpha` on a remote host — requires the explicit production override.
 */
export function classifyRestoreTarget(url: string, nodeEnv?: string): RestoreTarget {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const isLoopback = LOCAL_HOSTS.has(host);
  const isProd = nodeEnv === "production";
  const local = isLoopback && !isProd;
  return {
    redacted: redactDatabaseUrl(url),
    local,
    requiresOverride: !local,
  };
}
