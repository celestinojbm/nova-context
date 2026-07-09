import { Jimp, JimpMime } from "jimp";
import { findSensitiveRanges, type RedactionType } from "./redaction.js";

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

export interface RedactImageResult {
  dataUrl: string;
  masked: number;
  tally: Record<string, number>;
}

const BOX_PADDING = 3;

/**
 * OCR the image, mask every sensitive word box, return the re-encoded image.
 * Throws ImageRedactionError when the image can't be decoded or OCR fails —
 * the caller decides the fail-safe (strict mode drops the image entirely).
 */
export async function redactImageDataUrl(
  engine: OcrEngine,
  dataUrl: string,
): Promise<RedactImageResult> {
  const { mime, buffer } = parseDataUrl(dataUrl);
  let ocr: OcrResult;
  try {
    ocr = await engine.recognize(buffer);
  } catch (err) {
    throw new ImageRedactionError(`ocr failed: ${(err as Error).message.slice(0, 120)}`);
  }
  const { boxes, tally } = classifySensitiveWords(ocr.words);
  if (!boxes.length) {
    return { dataUrl, masked: 0, tally: {} };
  }

  let image: Awaited<ReturnType<typeof Jimp.fromBuffer>>;
  try {
    image = await Jimp.fromBuffer(buffer);
  } catch (err) {
    throw new ImageRedactionError(`image decode failed: ${(err as Error).message.slice(0, 120)}`);
  }
  const w = image.bitmap.width;
  const h = image.bitmap.height;
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
  };
}
