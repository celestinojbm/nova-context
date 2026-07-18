/**
 * M15B (Hermes D03): restore-target classification + DSN redaction.
 *
 * `scripts/restore.sh` must NEVER print a raw DATABASE_URL (it can carry
 * credentials) and must not treat a real database as "local scratch" just
 * because its name contains a familiar string. Both concerns live here as a
 * pure, unit-tested function so the shell only consumes a safe verdict.
 *
 * M18A.2: a recovery DRILL may run against a temporary MANAGED (remote)
 * Postgres reached over an internal hostname — loopback-only would BLOCK every
 * real drill. `classifyScratchTarget` adds an EXPLICITLY-authorized remote
 * scratch class that passes only when every guard condition holds, and
 * `dbTargetFingerprint` binds WHICH database (never the credentials). This is
 * for the automated gate; `classifyRestoreTarget` (below) stays the arbiter
 * for `scripts/restore.sh`'s simpler local/production decision.
 */

import { createHash } from "node:crypto";

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

// ---------------------------------------------------------------------------
// M18A.2: explicitly-authorized remote scratch classification for the gate.
// ---------------------------------------------------------------------------

/**
 * Canonical identity of a database TARGET — WHICH database, never how to
 * authenticate to it. Binds protocol, normalized host, normalized/default
 * port, exact database name, and TLS-relevant query posture (`sslmode`/`ssl`).
 * Username and password are NEVER included, so the fingerprint can be published
 * and compared without exposing a credential. Throws on unparseable input.
 */
export function canonicalizeDbIdentity(url: string): string {
  const u = new URL(url);
  const proto = /^postgres(ql)?:$/i.test(u.protocol) ? "postgresql:" : u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  const port = u.port || "5432";
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const sslmode = (u.searchParams.get("sslmode") ?? "").toLowerCase();
  const sslRaw = (u.searchParams.get("ssl") ?? "").toLowerCase();
  const tls = sslmode || (sslRaw === "true" ? "require" : sslRaw === "false" ? "disable" : "");
  return `db|${proto}//${host}:${port}/${db}|tls=${tls}`;
}

/** sha256 of the canonical DB identity — safe to publish/compare (no creds). */
export function dbTargetFingerprint(url: string): string {
  return createHash("sha256").update(canonicalizeDbIdentity(url)).digest("hex");
}

export type ScratchVerdict = "local_scratch" | "remote_scratch" | "blocked" | "error";

export interface ScratchClassification {
  verdict: ScratchVerdict;
  /** Credential-free redacted DSN — safe to print. */
  redacted: string;
  /** Names-only reasons (never values) for a blocked/error verdict. */
  reasons: string[];
  /** Present when the DSN parses. Never printed by the guard (it is derived
   * from — though it does not reveal — the connection string). */
  fingerprint?: string;
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** The exact typed confirmation an operator must set to authorize a remote
 * scratch restore. A fixed sentinel — not a value that can be guessed from
 * other config. */
export const REMOTE_SCRATCH_CONFIRM = "RESTORE-TO-SCRATCH";

/**
 * Classify a restore target for the automated recovery gate. Returns:
 *   - `local_scratch`  — loopback host, non-production (proceed, as today);
 *   - `remote_scratch` — a remote target for which EVERY authorization
 *     condition holds (proceed);
 *   - `blocked`        — a remote target missing any condition, a mismatch, a
 *     primary-equal fingerprint, a production target, or a malformed EXPECTED
 *     value (refuse, before any mutation);
 *   - `error`          — the DATABASE_URL itself is missing/malformed (fail).
 *
 * There is deliberately NO generic "allow any remote restore" bypass: a remote
 * target must match an operator-declared host, database name, and fingerprint,
 * carry the run-id marker, be proven distinct from the primary, and carry the
 * typed confirmation. Reasons are names-only — no host, DSN, or value leaks.
 */
export function classifyScratchTarget(url: string, env: NodeJS.ProcessEnv): ScratchClassification {
  const redacted = redactDatabaseUrl(url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { verdict: "error", redacted, reasons: ["DATABASE_URL is malformed/unparseable"] };
  }
  const host = u.hostname.toLowerCase();
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!host || !db) {
    return { verdict: "error", redacted, reasons: ["DATABASE_URL is missing a host or database name"] };
  }
  const fingerprint = dbTargetFingerprint(url);
  const isLoopback = LOCAL_HOSTS.has(host);
  const isProd = env.NODE_ENV === "production";

  // A. Local scratch — loopback + non-production. Unchanged behavior.
  if (isLoopback && !isProd) {
    return { verdict: "local_scratch", redacted, reasons: [], fingerprint };
  }

  // B. Explicitly-authorized remote scratch — EVERY condition must hold.
  const reasons: string[] = [];
  if (env.NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH !== "yes") {
    reasons.push("remote scratch not authorized (NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH must be 'yes')");
  }
  if (env.NOVA_RESTORE_TARGET_CLASS !== "scratch") {
    reasons.push("NOVA_RESTORE_TARGET_CLASS must be 'scratch'");
  }
  if (env.NOVA_RESTORE_SCRATCH_CONFIRM !== REMOTE_SCRATCH_CONFIRM) {
    // A DISTINCT var from restore.sh's NOVA_RESTORE_CONFIRM, to avoid clobbering.
    reasons.push("explicit typed recovery confirmation absent/incorrect (NOVA_RESTORE_SCRATCH_CONFIRM)");
  }
  if (isProd) {
    reasons.push("target is production-classified (NODE_ENV=production) — never a scratch target");
  }

  const expectHost = (env.NOVA_RESTORE_EXPECT_HOST ?? "").trim().toLowerCase();
  const expectDb = (env.NOVA_RESTORE_EXPECT_DATABASE ?? "").trim();
  const expectFp = (env.NOVA_RESTORE_EXPECT_FINGERPRINT ?? "").trim().toLowerCase();
  const primaryFp = (env.NOVA_PRIMARY_DATABASE_FINGERPRINT ?? "").trim().toLowerCase();
  const runId = (env.NOVA_RECOVERY_RUN_ID ?? "").trim();

  // A malformed/absent EXPECTED value is a BLOCK, never a silent pass.
  if (!expectHost) reasons.push("NOVA_RESTORE_EXPECT_HOST absent");
  if (!expectDb) reasons.push("NOVA_RESTORE_EXPECT_DATABASE absent");
  if (!FINGERPRINT_RE.test(expectFp)) reasons.push("NOVA_RESTORE_EXPECT_FINGERPRINT absent/malformed (want 64-hex)");
  if (!FINGERPRINT_RE.test(primaryFp)) reasons.push("NOVA_PRIMARY_DATABASE_FINGERPRINT absent/malformed (want 64-hex)");
  if (!runId) reasons.push("NOVA_RECOVERY_RUN_ID absent");

  // Match the live target against the operator's declared expectations.
  if (expectHost && host !== expectHost) reasons.push("target host differs from NOVA_RESTORE_EXPECT_HOST");
  if (expectDb && db !== expectDb) reasons.push("target database differs from NOVA_RESTORE_EXPECT_DATABASE");
  if (FINGERPRINT_RE.test(expectFp) && fingerprint !== expectFp) {
    reasons.push("target fingerprint differs from NOVA_RESTORE_EXPECT_FINGERPRINT");
  }
  if (runId && !db.includes(runId)) reasons.push("database name does not contain NOVA_RECOVERY_RUN_ID (drill marker)");
  if (FINGERPRINT_RE.test(primaryFp) && fingerprint === primaryFp) {
    reasons.push("target fingerprint EQUALS the primary database fingerprint — refusing to restore over primary");
  }

  if (reasons.length) return { verdict: "blocked", redacted, reasons, fingerprint };
  return { verdict: "remote_scratch", redacted, reasons: [], fingerprint };
}
