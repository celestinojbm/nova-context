import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * M18A §4: validation-evidence retention.
 *
 * Render pre-deploy commands and one-off jobs run on EPHEMERAL filesystems —
 * a gate report written to artifacts/validation/ vanishes with the instance.
 * When the operator configures an evidence store (a PRIVATE prefix in the
 * separately-scoped backup bucket), the CLI uploads the sanitized reports
 * plus a meta.json (run id, mode, outcome, git sha, per-file sha256) to:
 *
 *   validation-evidence/<mode>/<run-id>/{report.json,report.md,junit.xml,meta.json}
 *
 * Env (names only; never printed):
 *   NOVA_VALIDATE_EVIDENCE_S3_BUCKET (enables retention)
 *   NOVA_VALIDATE_EVIDENCE_S3_REGION / _ENDPOINT / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY
 *   NOVA_VALIDATE_EVIDENCE_REQUIRED=yes  → an upload failure makes the gate
 *                                          exit non-zero even on PASS
 *
 * Guarantees:
 *   - only the already-sanitized reports are uploaded — no raw logs, no
 *     secrets, no captured content, no session/invite values (the reports
 *     never contain them by construction; the sanitizer runs upstream);
 *   - each file's sha256 is recorded in meta.json and echoed to the console
 *     so retained evidence is tamper-evident;
 *   - an upload failure is LOUD: the gate prints EVIDENCE RETENTION FAILED
 *     and never claims the evidence was retained.
 */

/** Minimal store contract (satisfied by @nova/context-engine ObjectStore). */
export interface EvidencePutStore {
  put(key: string, data: Buffer): Promise<void>;
}

export interface EvidenceResult {
  attempted: boolean;
  ok: boolean;
  prefix: string;
  /** file name → sha256 of the uploaded bytes */
  hashes: Record<string, string>;
  uploaded: string[];
  error?: string;
}

export function evidencePrefix(mode: string, runId: string): string {
  return `validation-evidence/${mode}/${runId}/`;
}

export async function retainEvidence(opts: {
  store: EvidencePutStore;
  mode: string;
  runId: string;
  outcome: string;
  gitSha: string;
  files: Array<{ path: string }>;
}): Promise<EvidenceResult> {
  const prefix = evidencePrefix(opts.mode, opts.runId);
  const hashes: Record<string, string> = {};
  const uploaded: string[] = [];
  try {
    for (const f of opts.files) {
      const buf = readFileSync(f.path);
      const name = basename(f.path);
      hashes[name] = createHash("sha256").update(buf).digest("hex");
      await opts.store.put(`${prefix}${name}`, buf);
      uploaded.push(name);
    }
    const meta = {
      run_id: opts.runId,
      mode: opts.mode,
      outcome: opts.outcome,
      git_sha: opts.gitSha,
      uploaded_at: new Date().toISOString(),
      files: hashes,
    };
    const metaBuf = Buffer.from(JSON.stringify(meta, null, 2));
    hashes["meta.json"] = createHash("sha256").update(metaBuf).digest("hex");
    await opts.store.put(`${prefix}meta.json`, metaBuf);
    uploaded.push("meta.json");
    return { attempted: true, ok: true, prefix, hashes, uploaded };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      prefix,
      hashes,
      uploaded,
      error: (err as Error).message,
    };
  }
}
