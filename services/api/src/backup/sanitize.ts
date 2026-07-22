/**
 * M18A.3 §5: sanitize runtime error text emitted by the backup S3 CLIs
 * (backup:publish-s3 / verify-s3 / fetch-s3) before it reaches stdout/stderr
 * (and therefore CI logs / gate evidence). The S3 SDK surfaces raw provider
 * details — access keys, secrets, endpoint hosts, resolved private IPs, bucket
 * names — in exception messages; none of those may leak. Mirrors the gate's
 * sanitizer policy but scoped to what these CLIs can see from the environment.
 */

const REDACTED = "[REDACTED]";

/** Env vars whose VALUES are secrets/identifiers and must never print. */
const SECRET_ENV_NAMES = [
  "NOVA_BACKUP_KEY",
  "NOVA_ENCRYPTION_KEY",
  "NOVA_ENCRYPTION_KEY_OLD",
  "DATABASE_URL",
  "NOVA_MEDIA_S3_ACCESS_KEY_ID",
  "NOVA_MEDIA_S3_SECRET_ACCESS_KEY",
  "NOVA_BACKUP_S3_ACCESS_KEY_ID",
  "NOVA_BACKUP_S3_SECRET_ACCESS_KEY",
  "NOVA_VALIDATE_EVIDENCE_S3_ACCESS_KEY_ID",
  "NOVA_VALIDATE_EVIDENCE_S3_SECRET_ACCESS_KEY",
];
/** Endpoints: redact the full URL AND its bare host / host:port (a DNS/socket
 * error renders the host without the scheme). */
const ENDPOINT_ENV_NAMES = [
  "NOVA_MEDIA_S3_ENDPOINT",
  "NOVA_BACKUP_S3_ENDPOINT",
  "NOVA_VALIDATE_EVIDENCE_S3_ENDPOINT",
];
/** Bucket names are private identifiers (also cover short 3-char names). */
const BUCKET_ENV_NAMES = [
  "NOVA_MEDIA_S3_BUCKET",
  "NOVA_BACKUP_S3_BUCKET",
  "NOVA_VALIDATE_EVIDENCE_S3_BUCKET",
];

function endpointVariants(endpoint: string): string[] {
  const out = new Set<string>([endpoint]);
  try {
    const u = new URL(endpoint);
    if (u.hostname) out.add(u.hostname);
    if (u.host) out.add(u.host);
  } catch {
    const bare = endpoint.replace(/^[a-z0-9+.-]+:\/\//i, "").replace(/\/.*$/, "");
    if (bare) {
      out.add(bare);
      out.add(bare.split(":")[0] ?? bare);
    }
  }
  return [...out];
}

const PATTERNS: Array<[RegExp, string]> = [
  // DSN credentials scheme://user:pass@host → scheme://[REDACTED]@host.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'@/]+@/gi, `$1://${REDACTED}@`],
  // AWS access key id + 32-byte hex keys (backup/encryption key shape).
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b[0-9a-fA-F]{64}\b/g, REDACTED],
  // Private-range IPv4 (+ optional :port) — resolved private endpoint IPs.
  [
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?\b/g,
    REDACTED,
  ],
];

export function sanitizeBackupError(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  let out = text;
  const literals: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (v && v.length >= 3) literals.push(v);
  }
  for (const name of ENDPOINT_ENV_NAMES) {
    const v = env[name];
    if (v) literals.push(...endpointVariants(v).filter((s) => s.length >= 3));
  }
  for (const name of BUCKET_ENV_NAMES) {
    const v = env[name];
    if (v && v.length >= 3) literals.push(v);
  }
  // Longest first so a substring of a longer secret doesn't leave a fragment.
  for (const v of [...new Set(literals)].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
