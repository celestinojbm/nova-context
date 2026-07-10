import type pg from "pg";
import type { ObjectStore } from "./object-store.js";

/**
 * M9 media cleanup: (1) drain the delete-queue tombstones (blob deletions
 * that failed during a user delete and must not vanish silently), and
 * (2) find and optionally remove ORPHAN blobs — objects in storage with no
 * moment_media row, e.g. from a crash between the blob write and the DB
 * insert. Everything here handles opaque ciphertext keys; nothing decrypts,
 * so the command runs without the encryption key.
 *
 * Safety properties:
 *   - dry-run is the default; deletion is an explicit opt-in;
 *   - a blob is only ever an orphan if its key appears in NO user's
 *     moment_media row (global valid-set, so cross-user deletion of valid
 *     media is structurally impossible);
 *   - blobs younger than minAgeMinutes are skipped — an in-flight capture
 *     writes the blob BEFORE the DB row, so very recent keys may simply
 *     not be referenced YET;
 *   - cleanup is audited per affected user with counts only (never keys,
 *     never content).
 */

export interface CleanupOptions {
  /** false = dry run (report only, delete nothing). */
  deleteOrphans: boolean;
  /** Blobs modified more recently than this are never touched. */
  minAgeMinutes: number;
  now?: Date;
}

export interface CleanupReport {
  storedObjects: number;
  validObjects: number;
  queueDeleted: number;
  queueRemaining: number;
  orphans: number;
  orphansSkippedRecent: number;
  orphansDeleted: number;
  dryRun: boolean;
}

/** Retry tombstoned deletes. Success removes the row; failure bumps attempts. */
export async function drainDeleteQueue(
  db: pg.Pool,
  store: ObjectStore,
  apply: boolean,
): Promise<{ deleted: number; remaining: number }> {
  const { rows } = await db.query<{ id: string; user_id: string; storage_key: string }>(
    `SELECT id, user_id, storage_key FROM media_delete_queue ORDER BY created_at ASC`,
  );
  if (!apply) return { deleted: 0, remaining: rows.length };
  let deleted = 0;
  let remaining = 0;
  for (const row of rows) {
    try {
      await store.delete(row.storage_key);
      await db.query(`DELETE FROM media_delete_queue WHERE id = $1`, [row.id]);
      deleted += 1;
    } catch (err) {
      remaining += 1;
      await db.query(
        `UPDATE media_delete_queue
         SET attempts = attempts + 1, last_error = $2, updated_at = now()
         WHERE id = $1`,
        [row.id, (err as Error).message.slice(0, 500)],
      );
    }
  }
  return { deleted, remaining };
}

export async function runMediaCleanup(
  db: pg.Pool,
  store: ObjectStore,
  opts: CleanupOptions,
): Promise<CleanupReport> {
  const now = opts.now ?? new Date();

  // 1. Tombstoned deletes first — they are known-dead keys, not orphans.
  const queue = await drainDeleteQueue(db, store, opts.deleteOrphans);

  // 2. Valid set: every key ANY moment_media row references (full + thumb).
  const valid = new Set<string>();
  const { rows: mediaRows } = await db.query<{ storage_key: string; thumb_key: string | null }>(
    `SELECT storage_key, thumb_key FROM moment_media`,
  );
  for (const row of mediaRows) {
    valid.add(row.storage_key);
    if (row.thumb_key) valid.add(row.thumb_key);
  }
  // Keys still tombstoned stay owned by the queue — not orphans.
  const { rows: queuedRows } = await db.query<{ storage_key: string }>(
    `SELECT storage_key FROM media_delete_queue`,
  );
  const stillQueued = new Set(queuedRows.map((r) => r.storage_key));

  // 3. Scan storage.
  const stored = await store.list();
  const minAgeMs = opts.minAgeMinutes * 60_000;
  let orphans = 0;
  let skippedRecent = 0;
  let deleted = 0;
  const perUser = new Map<string, number>();

  for (const obj of stored) {
    if (valid.has(obj.key) || stillQueued.has(obj.key)) continue;
    if (obj.lastModified && now.getTime() - obj.lastModified.getTime() < minAgeMs) {
      skippedRecent += 1;
      continue;
    }
    orphans += 1;
    if (opts.deleteOrphans) {
      await store.delete(obj.key);
      deleted += 1;
      // Keys are `userId/momentId/mediaId[-thumb]` — attribute by prefix.
      const owner = obj.key.split("/")[0] ?? "";
      perUser.set(owner, (perUser.get(owner) ?? 0) + 1);
    }
  }

  // 4. Audit per affected user (counts only; skip owners whose user row is
  // gone — the audit table requires a real user).
  for (const [owner, count] of perUser) {
    const user = await db.query(`SELECT 1 FROM users WHERE id = $1::uuid`, [owner]).catch(() => null);
    if (!user?.rowCount) continue;
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, detail)
       VALUES ($1, 'media.cleanup', 'media', $2)`,
      [owner, JSON.stringify({ orphans_deleted: count })],
    );
  }

  return {
    storedObjects: stored.length,
    validObjects: valid.size,
    queueDeleted: queue.deleted,
    queueRemaining: queue.remaining,
    orphans,
    orphansSkippedRecent: skippedRecent,
    orphansDeleted: deleted,
    dryRun: !opts.deleteOrphans,
  };
}
