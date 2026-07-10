import { Jimp, JimpMime } from "jimp";
import type { OcrEngine, OcrResult, OcrWord } from "@nova/context-engine/visual-redaction";

/**
 * Tesseract OCR adapter (M7). ON-PROCESS, no cloud: pixels never leave the
 * API for redaction. The worker is created lazily on first use and reused;
 * language data comes from NOVA_OCR_LANG_PATH (vendor it for air-gapped
 * deploys) or tesseract.js's default CDN. Every call is bounded by
 * NOVA_OCR_TIMEOUT_MS — a hang must not stall the capture path forever;
 * timeouts surface as failures so the strict-mode fail-safe can apply.
 */
export interface TesseractOptions {
  langPath?: string;
  timeoutMs: number;
}

interface TesseractWordLike {
  text: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export class TesseractOcrEngine implements OcrEngine {
  readonly name = "tesseract";
  private workerPromise: Promise<import("tesseract.js").Worker> | null = null;

  constructor(private readonly opts: TesseractOptions) {}

  private async worker(): Promise<import("tesseract.js").Worker> {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        const { createWorker } = await import("tesseract.js");
        return createWorker(
          "eng",
          undefined,
          this.opts.langPath ? { langPath: this.opts.langPath } : undefined,
        );
      })();
      // A failed init must not poison every later call.
      this.workerPromise.catch(() => {
        this.workerPromise = null;
      });
    }
    return this.workerPromise;
  }

  async recognize(image: Buffer): Promise<OcrResult> {
    const run = (async () => {
      // M14 (found in the alpha rehearsal): tesseract.js's worker thread
      // rethrows libpng read errors OUT OF BAND (process.nextTick), which
      // crashes the whole API on a corrupt/hostile image — the promise
      // rejection alone is not enough. Decode with Jimp first and hand
      // tesseract a clean re-encoded PNG: undecodable bytes fail HERE as a
      // normal rejection (→ redaction failure → existing fail-safes), and
      // tesseract only ever sees pixels Jimp could parse.
      const decoded = await Jimp.fromBuffer(image).catch((err) => {
        throw new Error(`image decode failed: ${(err as Error).message.slice(0, 120)}`);
      });
      const clean = await decoded.getBuffer(JimpMime.png);
      const worker = await this.worker();
      const { data } = await worker.recognize(clean, {}, { blocks: true });
      return { words: extractWords(data as unknown as Record<string, unknown>) };
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`ocr timed out after ${this.opts.timeoutMs}ms`)),
        this.opts.timeoutMs,
      );
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.workerPromise) return;
    const worker = await this.workerPromise.catch(() => null);
    await worker?.terminate().catch(() => undefined);
    this.workerPromise = null;
  }
}

/** tesseract.js result shapes vary by version (flat words vs blocks tree);
 * accept both. */
function extractWords(data: Record<string, unknown>): OcrWord[] {
  const out: OcrWord[] = [];
  const push = (w: TesseractWordLike) => {
    if (!w?.text?.trim() || !w.bbox) return;
    out.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
  };
  if (Array.isArray(data.words)) {
    for (const w of data.words as TesseractWordLike[]) push(w);
    return out;
  }
  const blocks = data.blocks as
    | Array<{ paragraphs?: Array<{ lines?: Array<{ words?: TesseractWordLike[] }> }> }>
    | undefined;
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) push(w);
      }
    }
  }
  return out;
}
