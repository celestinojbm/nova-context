import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import {
  MIN_ANALYSIS_HEIGHT,
  MIN_ANALYSIS_WIDTH,
  ImageRedactionError,
  meetsAnalysisFloor,
  redactImageDataUrl,
  type OcrEngine,
  type OcrResult,
  type OcrWord,
} from "./visual-redaction.js";

/**
 * M19A (Hermes D-10) — the coverage gate, coordinate handling and fail-closed
 * behaviour of `redactImageDataUrl`, with a scripted OCR engine so every case
 * is deterministic. The REAL-Tesseract resolution matrix lives in
 * services/api/test/integration/m19a-visual-redaction-ocr.test.ts.
 *
 * SYNTHETIC DATA ONLY — the "secret" below is a reserved example address.
 */
const SECRET = "alice@synthetic.test";

/** Solid-white canvas of the requested size, as a PNG data URL. */
async function blank(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  const buf = await img.getBuffer(JimpMime.png);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/** OCR engine that reports exactly the words it was given. */
function scripted(words: OcrWord[]): OcrEngine {
  return { name: "scripted", async recognize(): Promise<OcrResult> { return { words }; } };
}
const throwing = (msg = "boom"): OcrEngine => ({
  name: "throwing",
  async recognize(): Promise<OcrResult> { throw new Error(msg); },
});

const ABOVE = { w: MIN_ANALYSIS_WIDTH, h: MIN_ANALYSIS_HEIGHT };
const secretWord = (over: Partial<OcrWord> = {}): OcrWord => ({
  text: SECRET, x0: 100, y0: 100, x1: 400, y1: 130, ...over,
});

async function decode(dataUrl: string) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return await Jimp.fromBuffer(Buffer.from(b64, "base64"));
}
/** True when the pixel is opaque black (a mask). */
function isMasked(img: Awaited<ReturnType<typeof decode>>, x: number, y: number): boolean {
  const idx = (img.bitmap.width * y + x) * 4;
  const d = img.bitmap.data;
  return d[idx] === 0 && d[idx + 1] === 0 && d[idx + 2] === 0 && d[idx + 3] === 255;
}

describe("M19A meetsAnalysisFloor", () => {
  it("requires BOTH dimensions at or above the floor", () => {
    expect(meetsAnalysisFloor(MIN_ANALYSIS_WIDTH, MIN_ANALYSIS_HEIGHT)).toBe(true);
    expect(meetsAnalysisFloor(MIN_ANALYSIS_WIDTH - 1, MIN_ANALYSIS_HEIGHT)).toBe(false);
    expect(meetsAnalysisFloor(MIN_ANALYSIS_WIDTH, MIN_ANALYSIS_HEIGHT - 1)).toBe(false);
    expect(meetsAnalysisFloor(800, 450)).toBe(false); // the reproduced D-10 size
  });

  it("does NOT reject real, full-fidelity browser viewports", () => {
    // Failing closed on healthy input is its own defect. These are ordinary
    // captures that were never downscaled — the height floor must not eat
    // them. A 1366x768 laptop's viewport is ~625px tall after browser chrome.
    expect(meetsAnalysisFloor(1366, 625)).toBe(true);
    expect(meetsAnalysisFloor(1280, 600)).toBe(true);
    expect(meetsAnalysisFloor(1920, 955)).toBe(true);
    // …while a downscaled artifact and a degenerate sliver still fail.
    expect(meetsAnalysisFloor(800, 450)).toBe(false);
    expect(meetsAnalysisFloor(1920, 40)).toBe(false);
  });
});

describe("M19A coverage gate (D-10)", () => {
  it("below the floor → insufficient_resolution, OCR NEVER consulted, image untouched", async () => {
    let consulted = false;
    const engine: OcrEngine = {
      name: "spy",
      async recognize() { consulted = true; return { words: [secretWord()] }; },
    };
    const input = await blank(800, 450); // the exact D-10 downscale target
    const res = await redactImageDataUrl(engine, input);

    expect(res.coverage).toBe("insufficient_resolution");
    expect(consulted).toBe(false); // an unreadable artifact teaches us nothing
    expect(res.masked).toBe(0);
    expect(res.tally).toEqual({});
    expect(res.safeText).toBe(""); // never index text we could not trust
    expect(res.dataUrl).toBe(input); // caller decides the fail-safe, not us
    expect(res.width).toBe(800);
    expect(res.height).toBe(450);
  });

  it("REGRESSION D-10: zero boxes below the floor is NOT certified", async () => {
    // Before M19A this exact shape returned masked:0 and the caller stamped
    // 'applied' — a redaction guarantee over an unscanned image.
    const res = await redactImageDataUrl(scripted([]), await blank(800, 450));
    expect(res.coverage).not.toBe("certified");
  });

  it("at the floor with zero sensitive words → certified, masked 0 (genuinely nothing to mask)", async () => {
    const res = await redactImageDataUrl(
      scripted([{ text: "Quarterly roadmap", x0: 10, y0: 10, x1: 200, y1: 40 }]),
      await blank(ABOVE.w, ABOVE.h),
    );
    expect(res.coverage).toBe("certified");
    expect(res.masked).toBe(0);
    expect(res.safeText).toContain("Quarterly roadmap");
  });

  it("at the floor with a sensitive word → certified and the pixels are actually black", async () => {
    const res = await redactImageDataUrl(scripted([secretWord()]), await blank(ABOVE.w, ABOVE.h));
    expect(res.coverage).toBe("certified");
    expect(res.masked).toBe(1);
    const img = await decode(res.dataUrl);
    expect(isMasked(img, 250, 115)).toBe(true); // inside the box
    expect(isMasked(img, 900, 600)).toBe(false); // untouched elsewhere
    expect(res.safeText).not.toContain(SECRET); // never indexed
  });

  it("OCR failure still throws (unchanged) — never a silent certified pass", async () => {
    await expect(
      redactImageDataUrl(throwing(), await blank(ABOVE.w, ABOVE.h)),
    ).rejects.toBeInstanceOf(ImageRedactionError);
  });

  it("undecodable bytes throw before any coverage verdict", async () => {
    const bogus = `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`;
    await expect(redactImageDataUrl(scripted([]), bogus)).rejects.toBeInstanceOf(
      ImageRedactionError,
    );
  });
});

describe("M19A coordinate handling", () => {
  it("clamps boxes that run past the canvas edges", async () => {
    const res = await redactImageDataUrl(
      scripted([secretWord({ x0: -50, y0: -50, x1: 60, y1: 60 })]),
      await blank(ABOVE.w, ABOVE.h),
    );
    expect(res.masked).toBe(1);
    const img = await decode(res.dataUrl);
    expect(isMasked(img, 0, 0)).toBe(true);
    expect(img.bitmap.width).toBe(ABOVE.w); // canvas size unchanged
  });

  it("a box entirely outside the canvas masks nothing and does not throw", async () => {
    const res = await redactImageDataUrl(
      scripted([secretWord({ x0: 5000, y0: 5000, x1: 5100, y1: 5100 })]),
      await blank(ABOVE.w, ABOVE.h),
    );
    expect(res.coverage).toBe("certified");
    const img = await decode(res.dataUrl);
    expect(isMasked(img, 100, 100)).toBe(false);
  });

  it("overlapping boxes are idempotent — the union is black, nothing else is", async () => {
    const res = await redactImageDataUrl(
      scripted([
        secretWord({ x0: 100, y0: 100, x1: 300, y1: 140 }),
        secretWord({ x0: 250, y0: 100, x1: 500, y1: 140 }),
      ]),
      await blank(ABOVE.w, ABOVE.h),
    );
    const img = await decode(res.dataUrl);
    expect(isMasked(img, 150, 120)).toBe(true);
    expect(isMasked(img, 270, 120)).toBe(true); // overlap region
    expect(isMasked(img, 450, 120)).toBe(true);
    expect(isMasked(img, 600, 120)).toBe(false);
  });

  it("fractional coordinates round outward so no sensitive pixel is left uncovered", async () => {
    const res = await redactImageDataUrl(
      scripted([secretWord({ x0: 100.7, y0: 100.7, x1: 200.2, y1: 140.2 })]),
      await blank(ABOVE.w, ABOVE.h),
    );
    const img = await decode(res.dataUrl);
    expect(isMasked(img, 101, 101)).toBe(true);
    expect(isMasked(img, 200, 140)).toBe(true);
  });

  it("does not mutate the caller's input data URL", async () => {
    const input = await blank(ABOVE.w, ABOVE.h);
    const copy = String(input);
    const res = await redactImageDataUrl(scripted([secretWord()]), input);
    expect(input).toBe(copy);
    expect(res.dataUrl).not.toBe(input); // masked output is a new artifact
  });
});
