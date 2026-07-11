/**
 * Canonical inline-image data-URI detection (single source of truth).
 *
 * M15C (Hermes M15B-R01): detection MUST be case-insensitive. A data URI is
 * case-insensitive by spec, so `data:image/png;base64,...`,
 * `DATA:image/png;base64,...`, `Data:Image/png;base64,...`, and
 * `data:IMAGE/svg+xml,...` are all inline images and must be caught by every
 * sanitizer, extraction, and exclusion gate alike. A case-sensitive
 * `startsWith("data:image/")` let mixed-case variants bypass the legacy-media
 * sanitizer and backfill and leak through the API/export. Do NOT reintroduce
 * a lowercase prefix check — route every detection point through here.
 *
 * Dependency-free on purpose: this module ships in the browser extension
 * bundle (via capture-mode), so it must not pull in jimp/node-only code.
 */

/** Matches an inline image data URI, case-insensitively, tolerating leading
 * whitespace (`data:image/png…`, `DATA:IMAGE/svg+xml…`, ` data:image/…`). */
export const IMAGE_DATA_URL_RE = /^\s*data:image\//i;

/** Any data URI (`data:<mime>…`), case-insensitive — used to skip binary
 * payloads from text scanning, not as an exclusion gate. */
export const ANY_DATA_URL_RE = /^\s*data:/i;

/** True when `value` is an inline image data URI (any case). */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && IMAGE_DATA_URL_RE.test(value);
}

/** True when `value` is any data URI (any case). */
export function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && ANY_DATA_URL_RE.test(value);
}
