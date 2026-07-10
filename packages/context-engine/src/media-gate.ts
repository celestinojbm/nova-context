import type { ObjectStore } from "./object-store.js";
import { decryptBytesWithAny } from "./secret-box.js";

/**
 * M11: THE adapter media gate — the single rule for pixels leaving Nova
 * toward any external adapter. The API's MediaService.getForAdapter and
 * the worker's media reader both delegate here, so there is exactly one
 * place where the policy lives:
 *
 *   - strictly user-scoped (someone else's media == media that doesn't
 *     exist);
 *   - only media whose visual redaction provably ran (redaction_state
 *     'applied', or 'none' when the caller opts in) may pass, unless the
 *     user's EXPLICIT override is presented;
 *   - deleted/tombstoned media (row gone, or blob gone from storage) is
 *     blocked, never guessed at;
 *   - callers MUST audit each successful access (media.adapter_access) —
 *     this function returns what the audit needs, it does not write it.
 *
 * Decryption uses the keyring (current + previous keys) so the gate keeps
 * working during a gradual key rotation.
 */

/** The one query the gate needs — satisfied by pg.Pool and pg.Client. */
export interface GateDb {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type AdapterMediaFailure =
  | "not_found"
  | "redaction_not_applied"
  | "blob_missing"
  | "undecryptable";

export interface AdapterMediaResult {
  ok: true;
  id: string;
  contentType: string;
  /** Decrypted, already-redacted pixels. Never log; never store plaintext. */
  data: Buffer;
  redactionState: string;
}

export interface AdapterGateOptions {
  /** Explicit user override for media whose redaction did not run.
   * Default false — adapters must not pass unredacted media silently. */
  allowUnredacted?: boolean;
  /** Treat 'none' (image never carried maskable text) as safe. The API's
   * user-facing gate accepts it; the worker's execution gate historically
   * required strict 'applied' — both are expressible here. */
  allowNone?: boolean;
}

export async function readMediaForAdapter(
  db: GateDb,
  store: ObjectStore,
  keys: Buffer[],
  userId: string,
  mediaId: string,
  opts: AdapterGateOptions = {},
): Promise<AdapterMediaResult | { ok: false; reason: AdapterMediaFailure }> {
  const { rows } = await db.query(
    `SELECT id, content_type, storage_key, redaction_state
     FROM moment_media WHERE id = $1 AND user_id = $2`,
    [mediaId, userId],
  );
  const row = rows[0] as
    | { id: string; content_type: string; storage_key: string; redaction_state: string }
    | undefined;
  if (!row) return { ok: false, reason: "not_found" };

  const safe = new Set(["applied", ...(opts.allowNone ? ["none"] : [])]);
  if (!safe.has(row.redaction_state) && !opts.allowUnredacted) {
    return { ok: false, reason: "redaction_not_applied" };
  }
  const blob = await store.get(row.storage_key);
  if (!blob) return { ok: false, reason: "blob_missing" };
  let data: Buffer;
  try {
    data = decryptBytesWithAny(keys, blob);
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
  return {
    ok: true,
    id: row.id,
    contentType: row.content_type,
    data,
    redactionState: row.redaction_state,
  };
}
