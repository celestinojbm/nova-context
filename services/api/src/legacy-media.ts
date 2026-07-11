/**
 * M15B (Hermes delta D01): fail-closed sanitizer for LEGACY inline media in
 * a Context Moment payload.
 *
 * New captures extract images out of the payload into the encrypted media
 * pipeline, so their payload carries no pixels. But pre-M8 rows (and any row
 * the backfill could not safely migrate) may still hold `screenshot_data_url`
 * or nested `data:image/...` strings inside `context_moments.payload`. Those
 * blobs never passed the M15 media redaction gates, so no outward path may
 * return them.
 *
 * This runs on EVERY payload that leaves the API (single/list/search/project
 * moment responses, legacy `/v1/export`, and account export — all flow
 * through rowToMoment). It strips every inline image, drops the known
 * `screenshot_data_url` key, and — when anything was removed — replaces it
 * with safe metadata only. It never returns the original base64.
 */

const isImageDataUrl = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("data:image/");

export const LEGACY_MEDIA_EXCLUDED_REASON = "legacy_inline_media_not_verified";

export function sanitizeLegacyInlineMedia(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  let found = false;

  const walk = (v: unknown): unknown => {
    if (isImageDataUrl(v)) {
      found = true;
      return undefined; // drop the inline image
    }
    if (Array.isArray(v)) {
      return v.map(walk).filter((x) => x !== undefined);
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // Drop the known legacy inline-image key outright, whatever it holds
        // (defence in depth: even a non-`data:` legacy value is not served).
        if (k === "screenshot_data_url") {
          if (val !== undefined && val !== null) found = true;
          continue;
        }
        const next = walk(val);
        if (next !== undefined) out[k] = next;
      }
      return out;
    }
    return v;
  };

  const cleaned = walk(payload) as Record<string, unknown>;
  if (found) {
    return {
      ...cleaned,
      legacy_media_detected: true,
      legacy_media_excluded: true,
      excluded_reason: LEGACY_MEDIA_EXCLUDED_REASON,
    };
  }
  return cleaned;
}
