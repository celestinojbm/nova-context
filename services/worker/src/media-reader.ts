import {
  readMediaForAdapter,
  type AdapterMediaFailure,
} from "@nova/context-engine/media-gate";
import type { ObjectStore } from "@nova/context-engine/object-store";
import type pg from "pg";

/**
 * M10/M11: the worker's adapter media read — a thin wrapper over THE
 * shared gate (`@nova/context-engine/media-gate`), the same code path
 * `MediaService.getForAdapter` uses, so the policy cannot drift between
 * services. Execution keeps the STRICTER stance: only redaction_state
 * 'applied' passes (no 'none', no override) — what the user ticked at
 * approval is exactly what may leave. Callers audit each success
 * (media.adapter_access) BEFORE upload.
 */
export interface AdapterMedia {
  id: string;
  contentType: string;
  data: Buffer; // decrypted, already-redacted pixels
}

export type { AdapterMediaFailure };

export async function readApprovedMedia(
  db: pg.Pool,
  store: ObjectStore,
  keys: Buffer[],
  userId: string,
  mediaId: string,
): Promise<{ ok: true; media: AdapterMedia } | { ok: false; reason: AdapterMediaFailure }> {
  const result = await readMediaForAdapter(db, store, keys, userId, mediaId, {
    allowNone: false,
    allowUnredacted: false,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    media: { id: result.id, contentType: result.contentType, data: result.data },
  };
}
