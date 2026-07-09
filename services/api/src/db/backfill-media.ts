import { parseEncryptionKey } from "@nova/context-engine/secret-box";
import {
  redactImageDataUrl,
  type OcrEngine,
} from "@nova/context-engine/visual-redaction";
import pg from "pg";
import { loadEnv } from "../env.js";
import { extractPayloadImages } from "../image-redaction.js";
import { MediaService } from "../media/media-service.js";
import { FsObjectStore, S3ObjectStore, type ObjectStore } from "../media/object-store.js";
import { TesseractOcrEngine } from "../ocr.js";

/**
 * M8 legacy-media backfill (manual, idempotent, safe):
 *
 *   pnpm --filter @nova/api media:backfill
 *
 * Moves inline `data:image/...` payload blobs from pre-M8 moments into the
 * media pipeline (encrypted object storage + moment_media). Policy:
 *   - image_redaction.state = 'applied' (M7 rows): already masked at
 *     capture — moved as-is.
 *   - anything else (pre-M7 '{}', 'skipped', 'failed'): NOT provably
 *     redacted — re-run visual redaction now; only masked output is
 *     stored. If OCR is unavailable or fails, the moment is SKIPPED and
 *     left exactly as it was (inline, no data loss, no unredacted media
 *     in object storage). Re-run after fixing OCR to pick strays up.
 *
 * Deliberately manual: an operator watches the counts. Nothing destructive
 * happens on failure paths.
 */
const env = loadEnv();
if (!env.NOVA_ENCRYPTION_KEY) {
  console.error("NOVA_ENCRYPTION_KEY is required — media is encrypted at rest.");
  process.exit(1);
}
const key = parseEncryptionKey(env.NOVA_ENCRYPTION_KEY);
const store: ObjectStore =
  env.NOVA_MEDIA_STORE === "s3"
    ? new S3ObjectStore({
        bucket: env.NOVA_MEDIA_S3_BUCKET!,
        region: env.NOVA_MEDIA_S3_REGION,
        endpoint: env.NOVA_MEDIA_S3_ENDPOINT,
        accessKeyId: env.NOVA_MEDIA_S3_ACCESS_KEY_ID!,
        secretAccessKey: env.NOVA_MEDIA_S3_SECRET_ACCESS_KEY!,
      })
    : new FsObjectStore(env.NOVA_MEDIA_FS_ROOT);
const ocr: OcrEngine | null =
  env.NOVA_IMAGE_REDACTION === "on"
    ? new TesseractOcrEngine({ langPath: env.NOVA_OCR_LANG_PATH, timeoutMs: env.NOVA_OCR_TIMEOUT_MS })
    : null;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
const media = new MediaService(pool, store, key);

const { rows } = await pool.query<{
  id: string;
  user_id: string;
  payload: Record<string, unknown>;
  image_redaction: { state?: string } | null;
}>(
  `SELECT id, user_id, payload, image_redaction FROM context_moments
   WHERE payload::text LIKE '%data:image%' ORDER BY captured_at ASC`,
);
console.log(`Found ${rows.length} moment(s) with inline media.`);

let migrated = 0;
let skipped = 0;
for (const row of rows) {
  const state = row.image_redaction?.state;
  let payload = row.payload;
  let finalState = state ?? "unknown";
  let ocrText: string | null = null;

  if (state !== "applied") {
    // Not provably redacted — re-redact now or skip.
    if (!ocr) {
      skipped += 1;
      continue;
    }
    try {
      const texts: string[] = [];
      const walk = async (v: unknown): Promise<unknown> => {
        if (typeof v === "string" && v.startsWith("data:image/")) {
          const result = await redactImageDataUrl(ocr, v);
          if (result.safeText) texts.push(result.safeText);
          return result.dataUrl;
        }
        if (Array.isArray(v)) return Promise.all(v.map(walk));
        if (v && typeof v === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = await walk(val);
          }
          return out;
        }
        return v;
      };
      payload = (await walk(payload)) as Record<string, unknown>;
      finalState = "applied";
      ocrText = texts.length ? texts.join("\n").slice(0, 50_000) : null;
    } catch (err) {
      console.warn(`  skip ${row.id}: redaction failed (${(err as Error).message})`);
      skipped += 1;
      continue;
    }
  }

  const extraction = extractPayloadImages(payload);
  if (!extraction.images.length) {
    skipped += 1;
    continue;
  }
  await media.storeMomentImages(row.user_id, row.id, extraction.images, finalState);
  await pool.query(
    `UPDATE context_moments
     SET payload = $1,
         image_redaction = jsonb_set(coalesce(image_redaction, '{}'), '{state}', to_jsonb($2::text)),
         ocr_text = coalesce($3, ocr_text)
     WHERE id = $4`,
    [JSON.stringify(extraction.payload), finalState, ocrText, row.id],
  );
  await pool.query(
    `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
     VALUES ($1, 'media.backfill', 'moment', $2, $3)`,
    [row.user_id, row.id, JSON.stringify({ media: extraction.images.length, state: finalState })],
  );
  migrated += 1;
}

console.log(`Backfill complete: ${migrated} migrated, ${skipped} skipped (left untouched).`);
if (ocr instanceof TesseractOcrEngine) await ocr.close();
await pool.end();
