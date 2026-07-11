/**
 * Capture-mode safeguards (M4): what visual data a capture may include.
 *   'full'          — screenshot stored as-is (still downscaled)
 *   'blurred'       — screenshot blurred client-side before storage
 *   'text_only'     — no screenshot at all; DOM text only
 * Applied client-side before upload; applyCaptureMode is the pure,
 * unit-tested enforcement used by the extension for both instant capture
 * and live-session frames.
 */

import { isImageDataUrl } from "./data-url.js";

export type CaptureMode = "full" | "blurred" | "text_only";

export const CAPTURE_MODES: Array<{ value: CaptureMode; label: string }> = [
  { value: "full", label: "Full screenshots (default)" },
  { value: "blurred", label: "Blur screenshots before storing" },
  { value: "text_only", label: "Text only — never store screenshots" },
];

/** Strip image payloads according to the mode. Blurring itself happens at
 * capture time (canvas filter); this function guarantees text_only mode
 * cannot leak an image payload no matter what the caller assembled.
 *
 * M16 (Hermes M15C accepted-P3): the walk now recurses into ARRAYS too — an
 * inline image hidden inside an array (e.g. `frames: ["DATA:image/…"]`) is
 * dropped, not passed through. Detection is the canonical case-insensitive
 * `isImageDataUrl`, so mixed-case variants are caught here as well. */
export function applyCaptureMode<T extends Record<string, unknown>>(
  payload: T,
  mode: CaptureMode,
): T {
  if (mode !== "text_only") return payload;
  return stripTextOnly(payload) as T;
}

/** Recursively drop inline images and the screenshot key from any JSON value
 * (objects AND arrays). Returns `undefined` for a value that is itself an
 * inline image so the caller can omit it. */
function stripTextOnly(value: unknown): unknown {
  if (isImageDataUrl(value)) return undefined;
  if (Array.isArray(value)) {
    return value.map(stripTextOnly).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === "screenshot_data_url") continue;
      const next = stripTextOnly(v);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

/** Whether frame sampling should run at all in live sessions. */
export function framesAllowed(mode: CaptureMode): boolean {
  return mode !== "text_only";
}
