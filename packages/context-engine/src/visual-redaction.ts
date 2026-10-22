import { Jimp, JimpMime } from "jimp";
import { findSensitiveRanges, type RedactionType } from "./redaction.js";

// Canonical, case-insensitive inline-image detection (M15C / Hermes
// M15B-R01). Re-exported here so the API's Node-only image helpers keep
// importing detection from `@nova/context-engine/visual-redaction`.
export { IMAGE_DATA_URL_RE, isImageDataUrl, isDataUrl } from "./data-url.js";

/**
 * Visual Redaction v1 (M7): OCR-box masking for screenshots and live-session
 * frames. An OCR engine (pluggable; Tesseract in production, fakes in tests)
 * yields word bounding boxes; the SAME detectors that redact captured text
 * classify the OCR'd lines, plus two image-specific heuristics (one-time
 * codes near their label, conservative street addresses); matched words are
 * painted over with opaque black rectangles BEFORE the image is stored,
 * exported, answered over, or handed to any adapter.
 *
 * Node-only (jimp) — imported via the `@nova/context-engine/visual-redaction`
 * subpath so the browser extension bundle never pulls it in.
 */

export type VisualRedactionType = RedactionType | "auth_code" | "address";

export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrResult {
  words: OcrWord[];
}

export interface OcrEngine {
  readonly name: string;
  recognize(image: Buffer): Promise<OcrResult>;
}

export interface SensitiveBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  type: VisualRedactionType;
}

/** Image-specific detectors, applied to reconstructed OCR lines. Both are
 * deliberately conservative — a false positive destroys real pixels. */
const EXTRA_DETECTORS: Array<{
  type: VisualRedactionType;
  pattern: RegExp;
  group?: number;
}> = [
  {
    // One-time codes only when their label is on the same line (allows a
    // short connector like "is"/":" between label and digits). Erring toward
    // masking here is cheap — a masked zip code loses little.
    type: "auth_code",
    pattern:
      /\b(?:code|otp|2fa|passcode|pin|verification(?:\s+code)?)\b[^0-9]{0,12}(\d{4,8})\b/gi,
    group: 1,
  },
  {
    // Street number + capitalized name + a street suffix.
    type: "address",
    pattern:
      /\b\d{1,5}\s+[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Terrace|Ter|Way)\b\.?/g,
  },
];

interface Line {
  words: OcrWord[];
  text: string;
  /** words[i] covers text[starts[i]..ends[i]) */
  starts: number[];
  ends: number[];
}

/** Group words into visual lines by vertical overlap, left-to-right. */
function toLines(words: OcrWord[]): Line[] {
  const sorted = [...words]
    .filter((w) => w.text.trim().length > 0)
    .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  const groups: OcrWord[][] = [];
  for (const word of sorted) {
    const cy = (word.y0 + word.y1) / 2;
    const current = groups[groups.length - 1];
    if (current) {
      const ref = current[0]!;
      const refMid = (ref.y0 + ref.y1) / 2;
      const tolerance = Math.max(ref.y1 - ref.y0, word.y1 - word.y0) * 0.7;
      if (Math.abs(cy - refMid) <= tolerance) {
        current.push(word);
        continue;
      }
    }
    groups.push([word]);
  }
  return groups.map((group) => {
    const inOrder = [...group].sort((a, b) => a.x0 - b.x0);
    let text = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (const word of inOrder) {
      if (text) text += " ";
      starts.push(text.length);
      text += word.text;
      ends.push(text.length);
    }
    return { words: inOrder, text, starts, ends };
  });
}

export interface ClassifyResult {
  boxes: SensitiveBox[];
  tally: Record<string, number>;
}

/** Map sensitive character ranges in each OCR line back to word boxes. */
export function classifySensitiveWords(words: OcrWord[]): ClassifyResult {
  const boxes: SensitiveBox[] = [];
  const tally: Record<string, number> = {};
  for (const line of toLines(words)) {
    const ranges: Array<{ start: number; end: number; type: VisualRedactionType }> = [
      ...findSensitiveRanges(line.text),
    ];
    for (const detector of EXTRA_DETECTORS) {
      const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line.text)) !== null) {
        if (!match[0].length) {
          pattern.lastIndex += 1;
          continue;
        }
        const target = detector.group != null ? match[detector.group] : match[0];
        if (!target) continue;
        const offset =
          detector.group != null ? match[0].indexOf(target) + match.index : match.index;
        ranges.push({ start: offset, end: offset + target.length, type: detector.type });
      }
    }
    for (const range of ranges) {
      tally[range.type] = (tally[range.type] ?? 0) + 1;
      for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i]!;
        if (line.starts[i]! < range.end && line.ends[i]! > range.start) {
          boxes.push({ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, type: range.type });
        }
      }
    }
  }
  return { boxes, tally };
}

export class ImageRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRedactionError";
  }
}

export function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new ImageRedactionError("not an image data URL");
  return { mime: match[1]!.toLowerCase(), buffer: Buffer.from(match[2]!, "base64") };
}

/**
 * M19A (Hermes D-10). Whether the analyzed artifact was large enough for
 * OCR-box masking to mean anything.
 *
 *   'certified'               — analysis ran at/above the resolution floor;
 *                               a zero-box result is a real "nothing
 *                               sensitive was found", not "nothing could be
 *                               read". Only this value may lead to 'applied'.
 *   'insufficient_resolution' — the artifact was below the floor. OCR output
 *                               (including an empty one) proves nothing here,
 *                               so the caller MUST fail closed.
 */
export type RedactionCoverage = "certified" | "insufficient_resolution";

export interface RedactImageResult {
  dataUrl: string;
  masked: number;
  tally: Record<string, number>;
  /** M8: OCR text with every sensitive word REMOVED (never redact-marked —
   * plain omission), for search indexing. Empty when OCR found nothing. */
  safeText: string;
  /** M19A: does this result carry a redaction guarantee at all? */
  coverage: RedactionCoverage;
  /** Analyzed pixel dimensions — counts only, never content. */
  width: number;
  height: number;
}

const BOX_PADDING = 3;

/**
 * M19A analysis-resolution floor.
 *
 * WHY A FLOOR AT ALL: OCR-box masking can only mask what OCR can read. The
 * capture client historically downscaled a 1920x1080 viewport to 800px wide
 * before upload; 14px body text became ~5.8px and Tesseract returned ZERO
 * words. Zero words means zero boxes, and the pipeline then reported the
 * unmasked image as 'applied' — a redaction guarantee over an image whose
 * secrets a human can still read (Hermes D-10, reproduced at 1366/1920/2560).
 *
 * WHY THESE NUMBERS: measured against real Tesseract with synthetic screens.
 * At 800x450 the sensitive-box count collapsed to 0 in 5 of 6 sampled
 * resolution/font combinations while the same screens at 1366x768, 1920x1080
 * and 2560x1440 detected every planted secret. 1280 is the conservative width
 * floor just below the smallest verified-good width.
 *
 * WHY WIDTH IS THE LOAD-BEARING CHECK: the defect is a WIDTH-driven downscale
 * — the client scaled to `maxWidth` and height followed by aspect ratio, so
 * width is the axis that determines the surviving glyph height. The height
 * minimum only rejects degenerate slivers (a "screenshot" that is not a
 * screen). It is deliberately NOT 720: a very common 1366x768 laptop has a
 * browser VIEWPORT of roughly 1366x625 after browser chrome, and a 720 floor
 * would silently drop every screenshot from that whole class of machine while
 * protecting against nothing — those captures are full-fidelity, never
 * downscaled. Failing closed is right; failing closed on healthy input is not.
 *
 * WHAT THIS IS NOT: not a recall guarantee. Above the floor OCR still misses
 * unusual fonts, low contrast, non-English text, and rendered-in-canvas text
 * (see docs/SECURITY_PRIVACY_GOVERNANCE.md). Nor is it a defence against an
 * artifact that was downscaled and then UPSCALED back over the floor — the
 * check reads pixel dimensions, not legibility. The floor removes a specific,
 * reproducible FALSE guarantee; it does not promise every secret is found.
 */
export const MIN_ANALYSIS_WIDTH = 1280;
export const MIN_ANALYSIS_HEIGHT = 600;

export function meetsAnalysisFloor(width: number, height: number): boolean {
  return width >= MIN_ANALYSIS_WIDTH && height >= MIN_ANALYSIS_HEIGHT;
}

/**
 * OCR the image, mask every sensitive word box, return the re-encoded image.
 * Throws ImageRedactionError when the image can't be decoded or OCR fails —
 * the caller decides the fail-safe (strict mode drops the image entirely).
 *
 * M19A ORDER (Hermes D-10): the image is DECODED FIRST so its true pixel
 * dimensions gate everything that follows. Below the analysis floor the
 * function returns `coverage: 'insufficient_resolution'` and does NOT run
 * OCR at all — an empty OCR result from an unreadable artifact must never be
 * mistaken for "nothing sensitive here". Masks are always painted into the
 * SAME decoded bitmap that is re-encoded and returned, so the artifact the
 * caller persists is the artifact that was analyzed.
 */
export async function redactImageDataUrl(
  engine: OcrEngine,
  dataUrl: string,
): Promise<RedactImageResult> {
  const { mime, buffer } = parseDataUrl(dataUrl);

  // 1. Decode first — dimensions decide whether any guarantee is possible.
  let image: Awaited<ReturnType<typeof Jimp.fromBuffer>>;
  try {
    image = await Jimp.fromBuffer(buffer);
  } catch (err) {
    throw new ImageRedactionError(`image decode failed: ${(err as Error).message.slice(0, 120)}`);
  }
  const w = image.bitmap.width;
  const h = image.bitmap.height;

  // 2. Resolution floor. Fail closed WITHOUT running OCR: at this size an
  //    empty result is uninformative, so there is nothing to learn and
  //    nothing we may certify.
  if (!meetsAnalysisFloor(w, h)) {
    return {
      dataUrl,
      masked: 0,
      tally: {},
      safeText: "",
      coverage: "insufficient_resolution",
      width: w,
      height: h,
    };
  }

  // 3. OCR the certified-resolution artifact.
  let ocr: OcrResult;
  try {
    ocr = await engine.recognize(buffer);
  } catch (err) {
    throw new ImageRedactionError(`ocr failed: ${(err as Error).message.slice(0, 120)}`);
  }
  const { boxes, tally } = classifySensitiveWords(ocr.words);
  const safeText = safeOcrText(ocr.words, boxes);
  if (!boxes.length) {
    // Certified resolution + successful OCR + no sensitive ranges = the image
    // genuinely carries nothing to mask. Safe to return as-is.
    return { dataUrl, masked: 0, tally: {}, safeText, coverage: "certified", width: w, height: h };
  }

  for (const box of boxes) {
    const x = Math.max(0, Math.floor(box.x0) - BOX_PADDING);
    const y = Math.max(0, Math.floor(box.y0) - BOX_PADDING);
    const x2 = Math.min(w, Math.ceil(box.x1) + BOX_PADDING);
    const y2 = Math.min(h, Math.ceil(box.y1) + BOX_PADDING);
    if (x2 <= x || y2 <= y) continue;
    image.scan(x, y, x2 - x, y2 - y, function (this: typeof image, _px, _py, idx) {
      this.bitmap.data[idx] = 0;
      this.bitmap.data[idx + 1] = 0;
      this.bitmap.data[idx + 2] = 0;
      this.bitmap.data[idx + 3] = 255;
    });
  }
  // PNG stays PNG (lossless black stays pure black); everything else JPEG.
  const outMime = mime === "image/png" ? JimpMime.png : JimpMime.jpeg;
  const out = await image.getBuffer(outMime);
  return {
    dataUrl: `data:${outMime};base64,${out.toString("base64")}`,
    masked: boxes.length,
    tally,
    safeText,
    coverage: "certified",
    width: w,
    height: h,
  };
}

/** Words that were not masked, in reading order — the searchable remainder. */
function safeOcrText(words: OcrWord[], boxes: SensitiveBox[]): string {
  const masked = new Set(boxes.map((b) => `${b.x0}:${b.y0}:${b.x1}:${b.y1}`));
  return toLines(words)
    .map((line) =>
      line.words
        .filter((w) => !masked.has(`${w.x0}:${w.y0}:${w.x1}:${w.y1}`))
        .map((w) => w.text)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n")
    .slice(0, 50_000);
}
