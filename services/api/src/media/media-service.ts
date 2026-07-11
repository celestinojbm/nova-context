import { readMediaForAdapter } from "@nova/context-engine/media-gate";
import { decryptBytesWithAny, encryptBytes } from "@nova/context-engine/secret-box";
import { parseDataUrl } from "@nova/context-engine/visual-redaction";
import { isSafeMediaRedactionState, type MomentMediaRef } from "@nova/schema";
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
  /** keys[0] is the CURRENT key (all writes); the rest are previous keys
   * still valid for reads during a gradual rotation (M11). */
  constructor(
    private readonly db: pg.Pool,
    private readonly store: ObjectStore,
    private readonly keys: Buffer[],
  ) {
    if (!keys.length) throw new Error("MediaService needs at least one key");
  }

  private get writeKey(): Buffer {
    return this.keys[0]!;
  }

  /** Encrypt + store images for a just-created moment; returns refs.
   *
   * M15 (Hermes P1) defence-in-depth: a blob is persisted ONLY when its
   * visual-redaction state is provably safe. On any unsafe state ('failed',
   * 'skipped', 'blocked_strict', unknown, …) NOTHING is stored — the moment
   * stands imageless rather than persist readable pixels. The capture path
   * already strips images for 'blocked_strict'/'storage_disabled'/
   * 'media_unavailable' and forces strict in production; this guard makes it
   * structurally impossible to write an unsafe blob even if that regresses. */
  async storeMomentImages(
    userId: string,
    momentId: string,
    images: IncomingImage[],
    redactionState: string,
  ): Promise<MomentMediaRef[]> {
    if (!isSafeMediaRedactionState(redactionState)) {
      // Unsafe redaction state ⇒ never store readable pixels.
      return [];
    }
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

      await this.store.put(storageKey, encryptBytes(this.writeKey, buffer));
      if (thumb) await this.store.put(thumbKey, encryptBytes(this.writeKey, thumb));

      const { rows } = await this.db.query<MediaRow>(
        `INSERT INTO moment_media
           (id, moment_id, user_id, kind, storage_key, thumb_key, content_type, bytes,
            thumb_bytes, width, height, encrypted, redaction_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)
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
          thumb ? thumb.length : null,
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
    // M15 (Hermes P1): the direct read must never return pixels for media in
    // an unsafe redaction state. Any legacy/edge row that predates the store
    // guard is treated as not-found rather than served unredacted.
    if (!isSafeMediaRedactionState(row.redaction_state)) return null;
    const useThumb = variant === "thumb" && row.thumb_key;
    const blob = await this.store.get(useThumb ? row.thumb_key! : row.storage_key);
    if (!blob) return null;
    return {
      contentType: useThumb ? "image/jpeg" : row.content_type,
      data: decryptBytesWithAny(this.keys, blob),
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

  /**
   * Object cleanup for moments about to be deleted (rows cascade with the
   * moment; blobs need explicit removal). M9 hardening: a blob delete that
   * fails does NOT fail the user's delete and does NOT vanish — the key is
   * tombstoned into media_delete_queue and retried by `media:cleanup`.
   */
  async deleteForMoments(
    userId: string,
    momentIds: string[],
  ): Promise<{ deleted: number; queued: number }> {
    if (!momentIds.length) return { deleted: 0, queued: 0 };
    const { rows } = await this.db.query<{ storage_key: string; thumb_key: string | null }>(
      `SELECT storage_key, thumb_key FROM moment_media
       WHERE user_id = $1 AND moment_id = ANY($2::uuid[])`,
      [userId, momentIds],
    );
    let deleted = 0;
    let queued = 0;
    for (const row of rows) {
      const keys = [row.storage_key, ...(row.thumb_key ? [row.thumb_key] : [])];
      let objectOk = true;
      for (const key of keys) {
        try {
          await this.store.delete(key);
        } catch (err) {
          objectOk = false;
          queued += 1;
          await this.enqueueBlobDelete(userId, key, (err as Error).message);
        }
      }
      if (objectOk) deleted += 1;
    }
    return { deleted, queued };
  }

  /** Tombstone a blob whose delete failed; UNIQUE(storage_key) makes
   * repeated failures bump attempts instead of duplicating rows. */
  private async enqueueBlobDelete(
    userId: string,
    storageKey: string,
    error: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO media_delete_queue (user_id, storage_key, last_error)
       VALUES ($1, $2, $3)
       ON CONFLICT (storage_key) DO UPDATE SET
         attempts = media_delete_queue.attempts + 1,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [userId, storageKey, error.slice(0, 500)],
    );
  }


  /**
   * Per-user storage accounting (M9). Aggregates only — object counts and
   * encrypted byte totals, never keys or content. thumb_bytes is null for
   * pre-M9 rows (documented; backfilled naturally as media churns).
   */
  async usageForUser(userId: string): Promise<{
    objects: number;
    total_bytes: number;
    thumbnail_bytes: number;
    by_kind: Record<string, { objects: number; bytes: number }>;
    by_redaction_state: Record<string, number>;
    by_project: Array<{ project_id: string | null; project_name: string | null; objects: number; bytes: number }>;
    pending_deletions: number;
  }> {
    const totals = await this.db.query<{ objects: string; bytes: string; thumb: string }>(
      `SELECT count(*) AS objects,
              coalesce(sum(bytes), 0) AS bytes,
              coalesce(sum(thumb_bytes), 0) AS thumb
       FROM moment_media WHERE user_id = $1`,
      [userId],
    );
    const byKind = await this.db.query<{ kind: string; objects: string; bytes: string }>(
      `SELECT kind, count(*) AS objects, coalesce(sum(bytes), 0) AS bytes
       FROM moment_media WHERE user_id = $1 GROUP BY kind`,
      [userId],
    );
    const byState = await this.db.query<{ redaction_state: string; objects: string }>(
      `SELECT redaction_state, count(*) AS objects
       FROM moment_media WHERE user_id = $1 GROUP BY redaction_state`,
      [userId],
    );
    const byProject = await this.db.query<{
      project_id: string | null;
      project_name: string | null;
      objects: string;
      bytes: string;
    }>(
      `SELECT m.project_id, p.name AS project_name,
              count(*) AS objects, coalesce(sum(mm.bytes), 0) AS bytes
       FROM moment_media mm
       JOIN context_moments m ON m.id = mm.moment_id
       LEFT JOIN projects p ON p.id = m.project_id
       WHERE mm.user_id = $1
       GROUP BY m.project_id, p.name
       ORDER BY count(*) DESC`,
      [userId],
    );
    const pending = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM media_delete_queue WHERE user_id = $1`,
      [userId],
    );
    return {
      objects: Number(totals.rows[0]!.objects),
      total_bytes: Number(totals.rows[0]!.bytes),
      thumbnail_bytes: Number(totals.rows[0]!.thumb),
      by_kind: Object.fromEntries(
        byKind.rows.map((r) => [r.kind, { objects: Number(r.objects), bytes: Number(r.bytes) }]),
      ),
      by_redaction_state: Object.fromEntries(
        byState.rows.map((r) => [r.redaction_state, Number(r.objects)]),
      ),
      by_project: byProject.rows.map((r) => ({
        project_id: r.project_id,
        project_name: r.project_name,
        objects: Number(r.objects),
        bytes: Number(r.bytes),
      })),
      pending_deletions: Number(pending.rows[0]!.n),
    };
  }

  /**
   * Adapter-facing read (M9; unified in M11). Delegates to THE shared
   * gate (`@nova/context-engine/media-gate`) — the same code path the
   * worker executes, so the policy cannot drift between services.
   * Callers MUST audit the access (media.adapter_access).
   */
  async getForAdapter(
    userId: string,
    mediaId: string,
    opts: { allowUnredacted?: boolean } = {},
  ): Promise<
    | { ok: true; contentType: string; data: Buffer; redactionState: string }
    | { ok: false; reason: "not_found" | "redaction_not_applied" }
  > {
    const result = await readMediaForAdapter(this.db, this.store, this.keys, userId, mediaId, {
      allowUnredacted: opts.allowUnredacted,
      allowNone: true,
    });
    if (!result.ok) {
      // Blob-missing/undecryptable map to not_found for API callers: the
      // media is effectively gone; details stay in ops logs, not responses.
      return {
        ok: false,
        reason: result.reason === "redaction_not_applied" ? "redaction_not_applied" : "not_found",
      };
    }
    return {
      ok: true,
      contentType: result.contentType,
      data: result.data,
      redactionState: result.redactionState,
    };
  }

  /** Export: redacted media as data URLs (the user's data, out in full).
   *
   * M15 (Hermes P1): pixels are inlined ONLY for provably safe redaction
   * states. Unsafe rows are still LISTED (so the export is honest about what
   * exists) but carry data_url=null + excluded_reason — the legacy
   * /v1/export and the account export both consume this, so neither can leak
   * unredacted pixels. This is the source-level guarantee; the account
   * export keeps its own belt-and-suspenders filter too. */
  async exportForMoments(
    userId: string,
    momentIds: string[],
  ): Promise<
    Map<string, Array<MomentMediaRef & { data_url: string | null; excluded_reason?: string }>>
  > {
    const out = new Map<
      string,
      Array<MomentMediaRef & { data_url: string | null; excluded_reason?: string }>
    >();
    if (!momentIds.length) return out;
    const { rows } = await this.db.query<MediaRow>(
      `SELECT id, moment_id, kind, content_type, bytes, width, height,
              redaction_state, storage_key, thumb_key
       FROM moment_media WHERE user_id = $1 AND moment_id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [userId, momentIds],
    );
    for (const row of rows) {
      const list = out.get(row.moment_id) ?? [];
      if (!isSafeMediaRedactionState(row.redaction_state)) {
        list.push({ ...toRef(row), data_url: null, excluded_reason: "redaction_not_applied" });
        out.set(row.moment_id, list);
        continue;
      }
      const blob = await this.store.get(row.storage_key);
      const dataUrl = blob
        ? `data:${row.content_type};base64,${decryptBytesWithAny(this.keys, blob).toString("base64")}`
        : null;
      list.push({ ...toRef(row), data_url: dataUrl });
      out.set(row.moment_id, list);
    }
    return out;
  }
}
