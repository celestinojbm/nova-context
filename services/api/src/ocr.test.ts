import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import { TesseractOcrEngine } from "./ocr.js";

/**
 * M14 regression (found in the alpha dress rehearsal): a corrupt PNG used
 * to reach tesseract.js, whose worker thread rethrows libpng errors OUT OF
 * BAND and crashes the whole API process. The engine now decodes with Jimp
 * first — undecodable bytes must reject as a NORMAL error before any
 * tesseract worker exists (this test would hit the network/CDN otherwise).
 */
describe("TesseractOcrEngine input hardening", () => {
  it("rejects undecodable image bytes cleanly, without spawning tesseract", async () => {
    const engine = new TesseractOcrEngine({ timeoutMs: 5_000 });
    await expect(engine.recognize(Buffer.from("not an image at all"))).rejects.toThrow(
      /image decode failed/,
    );
    // A truncated PNG (valid signature, corrupt body) — the exact shape of
    // the rehearsal crash — must fail the same controlled way.
    const png = await new Jimp({ width: 4, height: 4, color: 0xffffffff }).getBuffer(
      JimpMime.png,
    );
    await expect(
      engine.recognize(png.subarray(0, Math.floor(png.length / 2))),
    ).rejects.toThrow(/image decode failed/);
    await engine.close();
  });
});
