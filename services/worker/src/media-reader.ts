import { decryptBytes } from "@nova/context-engine/secret-box";
import type { ObjectStore } from "@nova/context-engine/object-store";
import type pg from "pg";

/**
 * M10: the worker's adapter-facing media read — the mirror of the API's
 * MediaService.getForAdapter, with the SAME guard: only the owner's media,
 * and only media whose visual redaction provably ran (redaction_state
 * 'applied'), can ever reach an external provider. Every successful read
 * is audited (media.adapter_access) by the caller BEFORE upload.
 */
export interface AdapterMedia {
  id: string;
  contentType: string;
  data: Buffer; // decrypted, already-redacted pixels
}

export type AdapterMediaFailure =
  | "not_found"
  | "redaction_not_applied"
  | "blob_missing";

export async function readApprovedMedia(
  db: pg.Pool,
  store: ObjectStore,
  key: Buffer,
  userId: string,
  mediaId: string,
): Promise<{ ok: true; media: AdapterMedia } | { ok: false; reason: AdapterMediaFailure }> {
  const { rows } = await db.query<{
    id: string;
    content_type: string;
    storage_key: string;
    redaction_state: string;
  }>(
    `SELECT id, content_type, storage_key, redaction_state
     FROM moment_media WHERE id = $1 AND user_id = $2`,
    [mediaId, userId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.redaction_state !== "applied") {
    return { ok: false, reason: "redaction_not_applied" };
  }
  const blob = await store.get(row.storage_key);
  if (!blob) return { ok: false, reason: "blob_missing" };
  return {
    ok: true,
    media: { id: row.id, contentType: row.content_type, data: decryptBytes(key, blob) },
  };
}
