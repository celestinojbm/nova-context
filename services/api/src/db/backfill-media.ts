import { parseEncryptionKey } from "@nova/context-engine/secret-box";
import {
  isImageDataUrl,
  redactImageDataUrl,
  type OcrEngine,
} from "@nova/context-engine/visual-redaction";
import pg from "pg";
import { loadEnv } from "../env.js";
import { extractPayloadImages } from "../image-redaction.js";
import { sanitizeLegacyInlineMedia } from "../legacy-media.js";
import { MediaService } from "../media/media-service.js";
import { storeFromEnv } from "../media/object-store.js";
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
 *     stored. If OCR is unavailable or fails, the moment is QUARANTINED
 *     (M15B / Hermes D01): the unverified inline pixels are stripped from
 *     the stored payload and the row is marked 'quarantined_legacy', so
 *     unredacted media never persists or leaks. The moment (text/metadata)
 *     survives; only the unverifiable image is removed.
 *
 * Deliberately manual: an operator watches the counts. Quarantine removes
 * only unverified inline pixels; every outward API/export path also strips
 * legacy inline media fail-closed (services/api/src/legacy-media.ts).
 */
const env = loadEnv();
if (!env.NOVA_ENCRYPTION_KEY) {
  console.error("NOVA_ENCRYPTION_KEY is required — media is encrypted at rest.");
  process.exit(1);
}
const key = parseEncryptionKey(env.NOVA_ENCRYPTION_KEY);
const store = storeFromEnv(env);
const ocr: OcrEngine | null =
  env.NOVA_IMAGE_REDACTION === "on"
    ? new TesseractOcrEngine({ langPath: env.NOVA_OCR_LANG_PATH, timeoutMs: env.NOVA_OCR_TIMEOUT_MS })
    : null;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
const media = new MediaService(pool, store, [key]);

/**
 * M15B (Hermes D01): quarantine a row whose inline media cannot be safely
 * migrated (OCR unavailable or redaction failed). We strip the unverified
 * inline `data:image` from the STORED payload — it never passed a redaction
 * gate, so it must not persist — mark the row 'quarantined_legacy', and
 * audit it. The moment itself (text, metadata) survives; only the
 * unverifiable pixels are removed. Idempotent: a sanitized row no longer
 * matches the inline-media scan on re-run.
 */
async function quarantine(row: { id: string; user_id: string; payload: Record<string, unknown> }): Promise<void> {
  const cleaned = sanitizeLegacyInlineMedia(row.payload) as Record<string, unknown>;
  await pool.query(
    `UPDATE context_moments
       SET payload = $1,
           image_redaction = jsonb_set(coalesce(image_redaction, '{}'), '{state}', to_jsonb('quarantined_legacy'::text))
     WHERE id = $2`,
    [JSON.stringify(cleaned), row.id],
  );
  await pool.query(
    `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
     VALUES ($1, 'media.backfill_quarantine', 'moment', $2, $3)`,
    [row.user_id, row.id, JSON.stringify({ reason: "legacy_inline_media_not_verified" })],
  );
}

const { rows } = await pool.query<{
  id: string;
  user_id: string;
  payload: Record<string, unknown>;
  image_redaction: { state?: string } | null;
}>(
  // M15C (Hermes M15B-R01): ILIKE, not LIKE — a mixed-case `DATA:image` /
  // `Data:Image` inline payload must be caught by the candidate scan too, or
  // the backfill would silently skip (and leave) it. Structured per-row
  // detection below (isImageDataUrl) is likewise case-insensitive.
  `SELECT id, user_id, payload, image_redaction FROM context_moments
   WHERE payload::text ILIKE '%data:image%' ORDER BY captured_at ASC`,
);
console.log(`Found ${rows.length} moment(s) with inline media.`);

let migrated = 0;
let quarantined = 0;
for (const row of rows) {
  const state = row.image_redaction?.state;
  let payload = row.payload;
  let finalState = state ?? "unknown";
  let ocrText: string | null = null;

  if (state !== "applied") {
    // Not provably redacted — re-redact now, or QUARANTINE (strip the
    // unverified inline pixels) so they never persist or leak.
    if (!ocr) {
      await quarantine(row);
      quarantined += 1;
      continue;
    }
    try {
      const texts: string[] = [];
      const walk = async (v: unknown): Promise<unknown> => {
        if (isImageDataUrl(v)) {
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
      console.warn(`  quarantine ${row.id}: redaction failed (${(err as Error).message})`);
      await quarantine(row);
      quarantined += 1;
      continue;
    }
  }

  const extraction = extractPayloadImages(payload);
  if (!extraction.images.length) {
    // Nothing extractable (already clean) — leave as-is.
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

console.log(
  `Backfill complete: ${migrated} migrated, ${quarantined} quarantined (unverified inline media stripped).`,
);
if (ocr instanceof TesseractOcrEngine) await ocr.close();
await pool.end();
