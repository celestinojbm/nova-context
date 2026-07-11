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
 * cannot leak an image payload no matter what the caller assembled. */
export function applyCaptureMode<T extends Record<string, unknown>>(
  payload: T,
  mode: CaptureMode,
): T {
  if (mode !== "text_only") return payload;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isImageDataUrl(value)) continue;
    if (key.toLowerCase() === "screenshot_data_url") continue;
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? applyCaptureMode(value as Record<string, unknown>, mode)
        : value;
  }
  return out as T;
}

/** Whether frame sampling should run at all in live sessions. */
export function framesAllowed(mode: CaptureMode): boolean {
  return mode !== "text_only";
}
