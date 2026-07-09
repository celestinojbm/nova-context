import { decryptBytes, encryptBytes } from "@nova/context-engine/secret-box";
import { parseDataUrl } from "@nova/context-engine/visual-redaction";
import type { MomentMediaRef } from "@nova/schema";
import { Jimp, JimpMime } from "jimp";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ObjectStore } from "./object-store.js";

/**
 * Media pipeline (M8). moment_media + object storage are the source of
 * truth for captured pixels; context_moments.payload carries NO images for
 * new moments. Every blob is AES-256-GCM ciphertext BEFORE it reaches the
 * store, and every read/delete is scoped by the owning user_id. Order is
 * enforced by the capture path: images arrive here ONLY after visual
 * redaction has run (or explicitly failed under non-strict settings — the
 * per-media redaction_state records which).
 */

const THUMB_WIDTH = 320;

export interface IncomingImage {
  dataUrl: string; // already visually redacted (or state says otherwise)
  kind: "screenshot" | "frame";
}

interface MediaRow {
  id: string;
  moment_id: string;
  kind: string;
  content_type: string;
  bytes: string | number | null;
  width: number | null;
  height: number | null;
  redaction_state: string;
  storage_key: string;
  thumb_key: string | null;
}

function toRef(row: MediaRow): MomentMediaRef {
  return {
    id: row.id,
    kind: row.kind,
    content_type: row.content_type,
    bytes: row.bytes == null ? null : Number(row.bytes),
    width: row.width,
    height: row.height,
    redaction_state: row.redaction_state,
    url: `/v1/media/${row.id}`,
    thumbnail_url: row.thumb_key ? `/v1/media/${row.id}?variant=thumb` : null,
  };
}

export class MediaService {
  constructor(
    private readonly db: pg.Pool,
    private readonly store: ObjectStore,
    private readonly key: Buffer,
  ) {}

  /** Encrypt + store images for a just-created moment; returns refs. */
  async storeMomentImages(
    userId: string,
    momentId: string,
    images: IncomingImage[],
    redactionState: string,
  ): Promise<MomentMediaRef[]> {
    const refs: MomentMediaRef[] = [];
    for (const image of images) {
      const { mime, buffer } = parseDataUrl(image.dataUrl);
      const mediaId = randomUUID();
      const storageKey = `${userId}/${momentId}/${mediaId}`;
      const thumbKey = `${storageKey}-thumb`;

      let width: number | null = null;
      let height: number | null = null;
      let thumb: Buffer | null = null;
      try {
        const decoded = await Jimp.fromBuffer(buffer);
        width = decoded.bitmap.width;
        height = decoded.bitmap.height;
        if (decoded.bitmap.width > THUMB_WIDTH) {
          decoded.resize({ w: THUMB_WIDTH });
        }
        thumb = await decoded.getBuffer(JimpMime.jpeg);
      } catch {
        // Undecodable image: store the original blob without a thumbnail.
        thumb = null;
      }

      await this.store.put(storageKey, encryptBytes(this.key, buffer));
      if (thumb) await this.store.put(thumbKey, encryptBytes(this.key, thumb));

      const { rows } = await this.db.query<MediaRow>(
        `INSERT INTO moment_media
           (id, moment_id, user_id, kind, storage_key, thumb_key, content_type, bytes,
            width, height, encrypted, redaction_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
         RETURNING id, moment_id, kind, content_type, bytes, width, height,
                   redaction_state, storage_key, thumb_key`,
        [
          mediaId,
          momentId,
          userId,
          image.kind,
          storageKey,
          thumb ? thumbKey : null,
          mime,
          buffer.length,
          width,
          height,
          redactionState,
        ],
      );
      refs.push(toRef(rows[0]!));
    }
    return refs;
  }

  /** User-scoped read: decrypts on the way out. null = not yours/not found. */
  async getMedia(
    userId: string,
    mediaId: string,
    variant: "full" | "thumb",
  ): Promise<{ contentType: string; data: Buffer } | null> {
    const { rows } = await this.db.query<MediaRow>(
      `SELECT id, moment_id, kind, content_type, bytes, width, height,
              redaction_state, storage_key, thumb_key
       FROM moment_media WHERE id = $1 AND user_id = $2`,
      [mediaId, userId],
    );
    const row = rows[0];
    if (!row) return null;
    const useThumb = variant === "thumb" && row.thumb_key;
    const blob = await this.store.get(useThumb ? row.thumb_key! : row.storage_key);
    if (!blob) return null;
    return {
      contentType: useThumb ? "image/jpeg" : row.content_type,
      data: decryptBytes(this.key, blob),
    };
  }

  /** Media refs for a batch of moments (one query, no N+1). */
  async listForMoments(momentIds: string[]): Promise<Map<string, MomentMediaRef[]>> {
    const out = new Map<string, MomentMediaRef[]>();
    if (!momentIds.length) return out;
    const { rows } = await this.db.query<MediaRow>(
      `SELECT id, moment_id, kind, content_type, bytes, width, height,
              redaction_state, storage_key, thumb_key
       FROM moment_media WHERE moment_id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [momentIds],
    );
    for (const row of rows) {
      const list = out.get(row.moment_id) ?? [];
      list.push(toRef(row));
      out.set(row.moment_id, list);
    }
    return out;
  }

  /** Object cleanup for moments about to be deleted (rows cascade with the
   * moment; blobs need explicit removal). Returns objects deleted. */
  async deleteForMoments(userId: string, momentIds: string[]): Promise<number> {
    if (!momentIds.length) return 0;
    const { rows } = await this.db.query<{ storage_key: string; thumb_key: string | null }>(
      `SELECT storage_key, thumb_key FROM moment_media
       WHERE user_id = $1 AND moment_id = ANY($2::uuid[])`,
      [userId, momentIds],
    );
    let deleted = 0;
    for (const row of rows) {
      await this.store.delete(row.storage_key);
      deleted += 1;
      if (row.thumb_key) await this.store.delete(row.thumb_key);
    }
    return deleted;
  }

  /** Export: redacted media as data URLs (the user's data, out in full). */
  async exportForMoments(
    userId: string,
    momentIds: string[],
  ): Promise<Map<string, Array<MomentMediaRef & { data_url: string | null }>>> {
    const out = new Map<string, Array<MomentMediaRef & { data_url: string | null }>>();
    if (!momentIds.length) return out;
    const { rows } = await this.db.query<MediaRow>(
      `SELECT id, moment_id, kind, content_type, bytes, width, height,
              redaction_state, storage_key, thumb_key
       FROM moment_media WHERE user_id = $1 AND moment_id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [userId, momentIds],
    );
    for (const row of rows) {
      const blob = await this.store.get(row.storage_key);
      const dataUrl = blob
        ? `data:${row.content_type};base64,${decryptBytes(this.key, blob).toString("base64")}`
        : null;
      const list = out.get(row.moment_id) ?? [];
      list.push({ ...toRef(row), data_url: dataUrl });
      out.set(row.moment_id, list);
    }
    return out;
  }
}
