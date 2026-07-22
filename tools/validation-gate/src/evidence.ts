import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sanitize } from "./sanitization.js";

/**
 * M18A §4 / M18A.1 finding 6: validation-evidence retention.
 *
 * Render pre-deploy commands and one-off jobs run on EPHEMERAL filesystems —
 * a gate report written to artifacts/validation/ vanishes with the instance.
 * When the operator configures an evidence store (a PRIVATE prefix in the
 * separately-scoped backup bucket), the CLI uploads the sanitized reports
 * plus a meta.json (run id, mode, outcome, git sha, per-file sha256) to:
 *
 *   validation-evidence/<mode>/<run-id>/{report.json,report.md,junit.xml,meta.json}
 *
 * M18A.1 hardening:
 *   - upload errors are SANITIZED (evidence keys/endpoint/bucket + the run's
 *     minted synthetic token/password/invite + the standard secret patterns)
 *     before they can reach stdout/stderr or any report;
 *   - meta.json is HMAC-authenticated with NOVA_BACKUP_KEY (when available)
 *     so retained evidence is tamper-EVIDENT, not merely corruption-checkable
 *     (the key is never placed in the evidence); without the key, meta is
 *     honestly marked `authenticated:false`;
 *   - meta.json is uploaded LAST, as the evidence-set COMMIT MARKER — a
 *     partial upload never presents as retained;
 *   - a failed upload is LOUD and never silently claimed as retained.
 */

/** Minimal store contract (satisfied by @nova/context-engine ObjectStore). */
export interface EvidencePutStore {
  put(key: string, data: Buffer): Promise<void>;
}

export interface EvidenceMetaBody {
  run_id: string;
  mode: string;
  outcome: string;
  git_sha: string;
  uploaded_at: string;
  authenticated: boolean;
  files: Record<string, string>; // filename -> sha256
}

export interface EvidenceMeta extends EvidenceMetaBody {
  /** HMAC-SHA256 of the canonical body with NOVA_BACKUP_KEY; "" if unkeyed. */
  mac: string;
}

export interface EvidenceResult {
  attempted: boolean;
  ok: boolean;
  prefix: string;
  hashes: Record<string, string>;
  uploaded: string[];
  authenticated: boolean;
  /** Already sanitized — safe to print. */
  error?: string;
}

export function evidencePrefix(mode: string, runId: string): string {
  return `validation-evidence/${mode}/${runId}/`;
}

function canonicalMeta(body: EvidenceMetaBody): string {
  return JSON.stringify({
    authenticated: body.authenticated,
    files: Object.fromEntries(Object.entries(body.files).sort(([a], [b]) => a.localeCompare(b))),
    git_sha: body.git_sha,
    mode: body.mode,
    outcome: body.outcome,
    run_id: body.run_id,
    uploaded_at: body.uploaded_at,
  });
}

export function evidenceMetaMac(body: EvidenceMetaBody, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalMeta(body)).digest("hex");
}

/** Verify a retained meta.json (tamper/wrong-key fails closed). */
export function verifyEvidenceMeta(meta: EvidenceMeta, key: Buffer): boolean {
  if (!meta.authenticated || typeof meta.mac !== "string" || !/^[0-9a-f]{64}$/.test(meta.mac)) {
    return false;
  }
  const { mac, ...body } = meta;
  const expected = evidenceMetaMac(body, key);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(mac, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function retainEvidence(opts: {
  store: EvidencePutStore;
  mode: string;
  runId: string;
  outcome: string;
  gitSha: string;
  uploadedAt: string;
  files: Array<{ path: string }>;
  /** Redact these (minted synthetic token/password/invite) in error output. */
  extraSecrets?: string[];
  /** HMAC-authenticate meta.json when supplied. Never uploaded. */
  backupKey?: Buffer;
  /** Redact known secret env values in error output. */
  env?: NodeJS.ProcessEnv;
}): Promise<EvidenceResult> {
  const prefix = evidencePrefix(opts.mode, opts.runId);
  const hashes: Record<string, string> = {};
  const uploaded: string[] = [];
  const authenticated = !!opts.backupKey;
  const scrub = (s: string): string =>
    sanitize(s, { extraSecrets: opts.extraSecrets ?? [], env: opts.env });
  try {
    // Upload the report files first; meta.json (the commit marker) is LAST.
    for (const f of opts.files) {
      const buf = readFileSync(f.path);
      const name = basename(f.path);
      hashes[name] = createHash("sha256").update(buf).digest("hex");
      await opts.store.put(`${prefix}${name}`, buf);
      uploaded.push(name);
    }
    const body: EvidenceMetaBody = {
      run_id: opts.runId,
      mode: opts.mode,
      outcome: opts.outcome,
      git_sha: opts.gitSha,
      uploaded_at: opts.uploadedAt,
      authenticated,
      files: hashes,
    };
    const meta: EvidenceMeta = {
      ...body,
      mac: opts.backupKey ? evidenceMetaMac(body, opts.backupKey) : "",
    };
    const metaBuf = Buffer.from(JSON.stringify(meta, null, 2));
    hashes["meta.json"] = createHash("sha256").update(metaBuf).digest("hex");
    await opts.store.put(`${prefix}meta.json`, metaBuf); // commit marker LAST
    uploaded.push("meta.json");
    return { attempted: true, ok: true, prefix, hashes, uploaded, authenticated };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      prefix,
      hashes,
      uploaded,
      authenticated,
      error: scrub((err as Error).message),
    };
  }
}
