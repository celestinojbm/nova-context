import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import type { OcrEngine, OcrResult, OcrWord } from "@nova/context-engine/visual-redaction";
import { MIN_ANALYSIS_HEIGHT, MIN_ANALYSIS_WIDTH } from "@nova/context-engine/visual-redaction";
import { isSafeMediaRedactionState } from "@nova/schema";
import { redactFrames, redactPayloadImages } from "./image-redaction.js";

/**
 * M19A (Hermes D-10) — the state the API reports must be HONEST. An image the
 * pipeline could not certify may never be reported as 'applied', in either
 * strict or non-strict mode, and must never be treated as safe to store.
 *
 * SYNTHETIC DATA ONLY.
 */
const SECRET = "alice@synthetic.test";

async function img(w: number, h: number): Promise<string> {
  const image = new Jimp({ width: w, height: h, color: 0xffffffff });
  const buf = await image.getBuffer(JimpMime.png);
  return `data:image/png;base64,${buf.toString("base64")}`;
}
const BIG = () => img(MIN_ANALYSIS_WIDTH, MIN_ANALYSIS_HEIGHT);
const SMALL = () => img(800, 450); // the reproduced D-10 downscale target

const scripted = (words: OcrWord[]): OcrEngine => ({
  name: "scripted",
  async recognize(): Promise<OcrResult> { return { words }; },
});
const throwing = (): OcrEngine => ({
  name: "throwing",
  async recognize(): Promise<OcrResult> { throw new Error("ocr exploded"); },
});
const SENSITIVE: OcrWord[] = [{ text: SECRET, x0: 50, y0: 50, x1: 300, y1: 90 }];

const opts = (ocr: OcrEngine | null, strict: boolean) => ({ ocr, strict, storageEnabled: true });
const hasImage = (p: unknown) =>
  typeof (p as { shot?: string }).shot === "string" &&
  (p as { shot: string }).shot.startsWith("data:image/");

describe("M19A honest redaction state (D-10)", () => {
  it("STRICT + uncertifiable image → blocked_strict AND the image is stripped", async () => {
    const out = await redactPayloadImages({ shot: await SMALL() }, opts(scripted([]), true));
    expect(out.report.state).toBe("blocked_strict");
    expect(hasImage(out.payload)).toBe(false); // nothing unscanned persists
    expect(isSafeMediaRedactionState(out.report.state)).toBe(false);
  });

  it("NON-STRICT + uncertifiable image → coverage_insufficient, kept but NOT safe", async () => {
    const out = await redactPayloadImages({ shot: await SMALL() }, opts(scripted([]), false));
    expect(out.report.state).toBe("coverage_insufficient");
    expect(hasImage(out.payload)).toBe(true); // non-strict keeps it, as before
    // …but every storage/read/export gate must still refuse it.
    expect(isSafeMediaRedactionState(out.report.state)).toBe(false);
  });

  it("REGRESSION D-10: a small image with planted secrets is never 'applied'", async () => {
    for (const strict of [true, false]) {
      const out = await redactPayloadImages({ shot: await SMALL() }, opts(scripted(SENSITIVE), strict));
      expect(out.report.state).not.toBe("applied");
      expect(out.report.masked).toBe(0); // no counts invented from an unscanned image
    }
  });

  it("certified image with sensitive content → applied, masked>0, safe", async () => {
    const out = await redactPayloadImages({ shot: await BIG() }, opts(scripted(SENSITIVE), true));
    expect(out.report.state).toBe("applied");
    expect(out.report.masked).toBe(1);
    expect(isSafeMediaRedactionState(out.report.state)).toBe(true);
    expect(hasImage(out.payload)).toBe(true);
  });

  it("certified image with nothing sensitive → applied, masked 0 (valid coverage)", async () => {
    const out = await redactPayloadImages(
      { shot: await BIG() },
      opts(scripted([{ text: "roadmap", x0: 5, y0: 5, x1: 90, y1: 30 }]), true),
    );
    expect(out.report.state).toBe("applied");
    expect(out.report.masked).toBe(0);
    expect(out.ocrText).toContain("roadmap");
  });

  it("uncertified images contribute NO ocrText (never index unread pixels)", async () => {
    const out = await redactPayloadImages({ shot: await SMALL() }, opts(scripted(SENSITIVE), false));
    expect(out.ocrText).toBeNull();
  });

  it("OCR failure still outranks coverage: 'failed' in non-strict, blocked in strict", async () => {
    const bad = await redactPayloadImages({ shot: await BIG() }, opts(throwing(), false));
    expect(bad.report.state).toBe("failed");
    const strictRun = await redactPayloadImages({ shot: await BIG() }, opts(throwing(), true));
    expect(strictRun.report.state).toBe("blocked_strict");
  });

  it("mixed batch: one certified + one uncertified → the WHOLE payload fails closed", async () => {
    const out = await redactPayloadImages(
      { shot: await BIG(), other: await SMALL() },
      { ...opts(scripted(SENSITIVE), true) },
    );
    expect(out.report.state).toBe("blocked_strict");
    expect(hasImage(out.payload)).toBe(false);
  });

  it("redaction disabled (ocr null) still reports 'skipped', not 'applied'", async () => {
    const out = await redactPayloadImages({ shot: await BIG() }, opts(null, true));
    expect(out.report.state).toBe("skipped");
    expect(isSafeMediaRedactionState(out.report.state)).toBe(false);
  });

  it("no image at all → 'none' (unchanged)", async () => {
    const out = await redactPayloadImages({ text: "hello" }, opts(scripted([]), true));
    expect(out.report.state).toBe("none");
  });
});

describe("M19A live frames fail closed (D-10)", () => {
  it("drops uncertifiable frames — unscanned pixels never reach the model", async () => {
    const res = await redactFrames([await SMALL()], scripted(SENSITIVE));
    expect(res.frames).toHaveLength(0);
    expect(res.dropped).toBe(1);
    expect(res.masked).toBe(0);
  });

  it("keeps certified frames and masks them", async () => {
    const res = await redactFrames([await BIG()], scripted(SENSITIVE));
    expect(res.frames).toHaveLength(1);
    expect(res.dropped).toBe(0);
    expect(res.masked).toBe(1);
  });

  it("mixed frames: only the certified one survives", async () => {
    const res = await redactFrames([await BIG(), await SMALL()], scripted(SENSITIVE));
    expect(res.frames).toHaveLength(1);
    expect(res.dropped).toBe(1);
  });
});
