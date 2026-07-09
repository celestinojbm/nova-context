import {
  ImageRedactionError,
  redactImageDataUrl,
  type OcrEngine,
} from "@nova/context-engine/visual-redaction";
import type { ImageRedactionReport } from "@nova/schema";

/**
 * M7 image pipeline shared by the capture path (screenshots inside the
 * moment payload) and live Q&A (frames sent with a question). Walks a
 * JSON-ish value, redacts every `data:image/...` string it finds, and
 * produces a values-free report. Fail-safes:
 *   - capture, strict mode:      OCR failure ⇒ image DROPPED ('blocked_strict')
 *   - capture, non-strict:       OCR failure ⇒ image kept, state 'failed'
 *   - storage kill switch (env): images stripped before anything else
 *   - live Q&A frames:           OCR failure ⇒ frame DROPPED (always strict —
 *                                nothing unredacted may reach a cloud model)
 */

const MAX_IMAGES_PER_PAYLOAD = 6;

export interface PayloadImageOptions {
  /** null = image redaction disabled/off. */
  ocr: OcrEngine | null;
  strict: boolean;
  storageEnabled: boolean;
}

export interface PayloadImageOutcome<T> {
  payload: T;
  report: Required<ImageRedactionReport>;
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

function stripImages<T>(value: T): { value: T; stripped: number } {
  let stripped = 0;
  const walk = (v: unknown): unknown => {
    if (isImageDataUrl(v)) {
      stripped += 1;
      return undefined;
    }
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const next = walk(val);
        if (next !== undefined) out[k] = next;
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, stripped };
}

export async function redactPayloadImages<T>(
  payload: T,
  opts: PayloadImageOptions,
): Promise<PayloadImageOutcome<T>> {
  const report: Required<ImageRedactionReport> = { state: "none", masked: 0, tally: {} };

  if (!opts.storageEnabled) {
    const { value, stripped } = stripImages(payload);
    report.state = stripped > 0 ? "storage_disabled" : "none";
    return { payload: value, report };
  }

  // Collect image locations first so failures can strip them all at once.
  let seen = 0;
  let failed = false;
  const walk = async (v: unknown): Promise<unknown> => {
    if (isImageDataUrl(v)) {
      seen += 1;
      if (seen > MAX_IMAGES_PER_PAYLOAD) {
        failed = true; // over budget = unscanned = unsafe
        return v;
      }
      if (!opts.ocr) return v;
      try {
        const result = await redactImageDataUrl(opts.ocr, v);
        report.masked += result.masked;
        for (const [type, n] of Object.entries(result.tally)) {
          report.tally[type] = (report.tally[type] ?? 0) + n;
        }
        return result.dataUrl;
      } catch (err) {
        if (!(err instanceof ImageRedactionError)) throw err;
        failed = true;
        return v;
      }
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

  let next = (await walk(payload)) as T;
  if (seen === 0) {
    report.state = "none";
    return { payload: next, report };
  }
  if (!opts.ocr) {
    report.state = "skipped";
    return { payload: next, report };
  }
  if (failed) {
    if (opts.strict) {
      next = stripImages(next).value;
      report.state = "blocked_strict";
    } else {
      report.state = "failed";
    }
    return { payload: next, report };
  }
  report.state = "applied";
  return { payload: next, report };
}

/** Live Q&A frames: mask each; a frame that cannot be redacted is dropped —
 * unredacted pixels never reach the model. */
export async function redactFrames(
  frames: string[],
  ocr: OcrEngine | null,
): Promise<{ frames: string[]; masked: number; dropped: number; redacted: boolean }> {
  if (!ocr) return { frames, masked: 0, dropped: 0, redacted: false };
  const out: string[] = [];
  let masked = 0;
  let dropped = 0;
  for (const frame of frames) {
    try {
      const result = await redactImageDataUrl(ocr, frame);
      masked += result.masked;
      out.push(result.dataUrl);
    } catch (err) {
      if (!(err instanceof ImageRedactionError)) throw err;
      dropped += 1;
    }
  }
  return { frames: out, masked, dropped, redacted: true };
}
