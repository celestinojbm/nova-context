/**
 * Centralized output sanitization (M17B §8).
 *
 * Everything that can reach a report (stdout/stderr excerpts, summaries,
 * blocking reasons, command descriptions, thrown errors) flows through
 * `sanitize()`. Two layers, both always on:
 *   1. exact-value redaction of KNOWN secret env vars present in the
 *      process environment;
 *   2. pattern-based redaction for secret shapes (DSN credentials, bearer
 *      tokens, API keys, 32-byte hex keys, data: URLs, private keys) so a
 *      secret that never lived in our env is still caught.
 *
 * Marker is always `[REDACTED]` (data URLs: `[REDACTED_DATA_URL]`). Debug
 * mode never bypasses this module.
 */

export const REDACTED = "[REDACTED]";

/** Env vars whose VALUES are secrets and must never appear in output. */
export const SECRET_ENV_NAMES = [
  "DATABASE_URL",
  "REDIS_URL",
  "NOVA_ENCRYPTION_KEY",
  "NOVA_ENCRYPTION_KEY_OLD",
  "NOVA_ENCRYPTION_KEYS_PREVIOUS",
  "NOVA_BACKUP_KEY",
  "NOVA_ALPHA_INVITE_CODE",
  "NOVA_MEDIA_S3_ACCESS_KEY_ID",
  "NOVA_MEDIA_S3_SECRET_ACCESS_KEY",
  "NOVA_BACKUP_S3_ACCESS_KEY_ID",
  "NOVA_BACKUP_S3_SECRET_ACCESS_KEY",
  "NOVA_VALIDATE_EVIDENCE_S3_ACCESS_KEY_ID",
  "NOVA_VALIDATE_EVIDENCE_S3_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NOTION_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NOVA_VALIDATE_SESSION_TOKEN",
  "NOVA_SMOKE_INVITE",
] as const;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pattern layer. Order matters: URLs-with-credentials before generic k=v. */
const PATTERNS: Array<[RegExp, string]> = [
  // Private key blocks.
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // DSN credentials: scheme://user:pass@host → scheme://[REDACTED]@host.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'@/]+@/gi, `$1://${REDACTED}@`],
  // Inline data URLs (any case, any mime) — captured content never ships.
  [/data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,][^\s"')]*/gi, "[REDACTED_DATA_URL]"],
  // Provider key shapes.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // 32-byte hex keys (NOVA_ENCRYPTION_KEY / NOVA_BACKUP_KEY shape).
  [/\b[0-9a-fA-F]{64}\b/g, REDACTED],
  // Private-range IPv4 (+ optional :port). Infra error strings such as
  // "connect ECONNREFUSED 10.0.3.4:9000" leak the private endpoint IP the
  // evidence/media store lives behind, which the full-URL literal never
  // matches (M18A.1 review). Only RFC1918 / link-local / CGNAT ranges are
  // redacted — loopback (127.x) is not sensitive and a full dotted quad never
  // collides with a semver (3 parts) or a port.
  [
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?\b/g,
    REDACTED,
  ],
  // Bearer / auth headers / cookies.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  // Generic secret-ish key=value / key: value assignments.
  [
    /\b((?:password|passwd|pwd|secret|token|session[_-]?token|access[_-]?key(?:[_-]?id)?|api[_-]?key|invite[_-]?code|client[_-]?secret)\s*[=:]\s*)[^\s&;,"']+/gi,
    `$1${REDACTED}`,
  ],
];

export interface SanitizeOptions {
  /** Additional literal secret values to strip (e.g. flag-supplied tokens). */
  extraSecrets?: string[];
  env?: NodeJS.ProcessEnv;
}

export function sanitize(text: string, opts: SanitizeOptions = {}): string {
  if (!text) return text;
  let out = text;

  // Layer 1: exact known env values (only meaningful lengths — redacting
  // "on"/"fs" would shred ordinary output).
  const env = opts.env ?? process.env;
  const literals: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (v && v.length >= 6) literals.push(v);
  }
  for (const v of opts.extraSecrets ?? []) {
    // Caller-supplied extraSecrets are EXPLICITLY declared secrets (a minted
    // token/password, or the private evidence bucket/endpoint host). Redact
    // them below the 6-char auto-detect floor too — an S3 bucket name may be
    // as short as 3 chars (M18A.1 review). Floor at 3 so a 1-2 char value
    // cannot shred ordinary output.
    if (v && v.length >= 3) literals.push(v);
  }
  // Longest first so substrings of other secrets don't leave fragments.
  literals.sort((a, b) => b.length - a.length);
  for (const v of literals) {
    out = out.replaceAll(v, REDACTED);
  }

  // Layer 2: shapes.
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Cap an output stream to head+tail excerpts BEFORE sanitizing, so reports
 * stay small and raw logs are never stored in full. */
export function excerpt(text: string, cap = 4000): string {
  if (text.length <= cap * 2) return text;
  return `${text.slice(0, cap)}\n… [${text.length - cap * 2} bytes elided] …\n${text.slice(-cap)}`;
}
