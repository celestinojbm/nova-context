import {
  MIN_ANALYSIS_HEIGHT,
  MIN_ANALYSIS_WIDTH,
} from "@nova/context-engine/visual-redaction";
import { Jimp, JimpMime, loadFont } from "jimp";
import { SANS_128_BLACK } from "jimp/fonts";
import { describe, expect, it } from "vitest";
import { redactPayloadImages } from "../../src/image-redaction.js";
import { TesseractOcrEngine } from "../../src/ocr.js";

/**
 * M19A (Hermes D-10) — the REAL-Tesseract resolution/font matrix.
 *
 * THE DEFECT THIS PINS: the capture client downscaled screenshots to 800px
 * wide before upload. At that size Tesseract read nothing, `classifySensitive
 * Words` produced zero boxes, and the pipeline stamped the still-legible image
 * `redaction_state: 'applied'`. Reproduced on this repo at c49ef4d — 5 of 6
 * sampled resolution/font combinations went from 1-5 detected boxes at native
 * resolution to ZERO boxes + 'applied' after the downscale.
 *
 * WHAT IS ASSERTED: not a detection rate. The invariant is that a downscaled
 * artifact can never end in 'applied' — either it is certified and masked, or
 * it fails closed. Detection quality above the floor is reported, not
 * asserted as absolute (OCR recall is never 100%).
 *
 * Gated behind NOVA_OCR_E2E=1, matching the M7 suite: Tesseract fetches ~2MB
 * of language data on first run and full-resolution OCR is slow. Run:
 *
 *   NOVA_OCR_E2E=1 pnpm --filter @nova/api vitest run \
 *     test/integration/m19a-visual-redaction-ocr.test.ts
 *
 * SYNTHETIC DATA ONLY — reserved example domains and a documented test card
 * number. No real credentials, no real PII, no real images.
 */
const enabled = process.env.NOVA_OCR_E2E === "1";

const SECRETS = [
  "alice@synthetic.test", // reserved TLD
  "4111 1111 1111 1111", // documented test PAN
  "555-867-5309", // fictional phone
];
/** Control line: must never be masked (false-positive canary). */
const CONTROL = "Quarterly planning notes";

/** Render synthetic "screen" text at an arbitrary pixel height. */
async function renderScreen(w: number, h: number, fontPx: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  const font = await loadFont(SANS_128_BLACK);
  let y = Math.floor(h * 0.1);
  for (const line of [...SECRETS, CONTROL]) {
    const strip = new Jimp({ width: 2600, height: 170, color: 0xffffffff });
    strip.print({ font, x: 0, y: 0, text: line });
    const scale = fontPx / 128;
    strip.resize({
      w: Math.max(1, Math.round(2600 * scale)),
      h: Math.max(1, Math.round(170 * scale)),
    });
    img.composite(strip, Math.floor(w * 0.05), y);
    y += Math.round(fontPx * 2.4);
  }
  const buf = await img.getBuffer(JimpMime.jpeg, { quality: 85 });
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/** The client-side downscale exactly as apps/extension/utils/capture.ts did. */
async function downscale(dataUrl: string, maxWidth: number, quality: number): Promise<string> {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const img = await Jimp.fromBuffer(Buffer.from(b64, "base64"));
  if (img.bitmap.width > maxWidth) {
    img.resize({
      w: maxWidth,
      h: Math.round(img.bitmap.height * (maxWidth / img.bitmap.width)),
    });
  }
  const out = await img.getBuffer(JimpMime.jpeg, { quality: Math.round(quality * 100) });
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

const RESOLUTIONS = [
  [1366, 768],
  [1920, 1080],
  [2560, 1440],
] as const;
/** §9.2 required font sizes. */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48] as const;

describe.skipIf(!enabled)("M19A: real Tesseract visual-redaction integrity (D-10)", () => {
  const engine = new TesseractOcrEngine({ timeoutMs: 120_000 });
  const run = (dataUrl: string, strict: boolean) =>
    redactPayloadImages({ shot: dataUrl }, { ocr: engine, strict, storageEnabled: true });

  it(
    "THE INVARIANT: a 800px-downscaled capture is NEVER 'applied' at any resolution",
    { timeout: 900_000 },
    async () => {
      const rows: string[] = [];
      for (const [w, h] of RESOLUTIONS) {
        for (const fontPx of [12, 14, 20] as const) {
          const shrunk = await downscale(await renderScreen(w, h, fontPx), 800, 0.75);
          const strict = await run(shrunk, true);
          const loose = await run(shrunk, false);
          rows.push(
            `${w}x${h} @${fontPx}px -> strict=${strict.report.state} nonstrict=${loose.report.state}`,
          );
          // The pre-M19A behaviour was 'applied' with masked:0. Both modes must
          // now refuse to certify, whatever OCR did or did not manage to read.
          expect(strict.report.state, rows.at(-1)).not.toBe("applied");
          expect(loose.report.state, rows.at(-1)).not.toBe("applied");
          // Strict additionally drops the pixels entirely.
          expect(strict.report.state).toBe("blocked_strict");
          expect(JSON.stringify(strict.payload)).not.toContain("data:image/");
        }
      }
      console.log("[M19A downscaled matrix]\n" + rows.join("\n"));
    },
  );

  it(
    "certified resolutions: every planted secret class is detected and masked",
    { timeout: 900_000 },
    async () => {
      // One representative certified size per resolution keeps this bounded;
      // the full font sweep runs in the next case at a single resolution.
      const rows: string[] = [];
      for (const [w, h] of RESOLUTIONS) {
        const native = await renderScreen(w, h, 24);
        const out = await run(native, true);
        rows.push(`${w}x${h} @24px -> ${out.report.state} masked=${out.report.masked}`);
        expect(out.report.state, rows.at(-1)).toBe("applied");
        expect(out.report.masked, rows.at(-1)).toBeGreaterThan(0);
        // The control line must survive — masking everything is not a fix.
        expect(out.ocrText ?? "").toMatch(/Quarterly|planning|notes/i);
      }
      console.log("[M19A certified matrix]\n" + rows.join("\n"));
    },
  );

  it(
    "font sweep 12..48px at 1920x1080: no size may produce a false 'applied' after downscale",
    { timeout: 900_000 },
    async () => {
      const rows: string[] = [];
      for (const fontPx of FONT_SIZES) {
        const native = await renderScreen(1920, 1080, fontPx);
        const shrunk = await downscale(native, 800, 0.75);
        const nativeOut = await run(native, true);
        const shrunkOut = await run(shrunk, true);
        rows.push(
          `@${fontPx}px native=${nativeOut.report.state}/${nativeOut.report.masked} ` +
            `downscaled=${shrunkOut.report.state}/${shrunkOut.report.masked}`,
        );
        // Native (certified) may be applied; downscaled may never be.
        expect(shrunkOut.report.state, rows.at(-1)).toBe("blocked_strict");
        expect(nativeOut.report.state, rows.at(-1)).toBe("applied");
      }
      console.log("[M19A font sweep 1920x1080]\n" + rows.join("\n"));
    },
  );

  it(
    "the new client capture width clears the floor and stays inside the schema cap",
    { timeout: 600_000 },
    async () => {
      // 2560x1440 is the worst case for payload size after the M19A change.
      const native = await renderScreen(2560, 1440, 16);
      const uploaded = await downscale(native, 1920, 0.8); // CAPTURE_MAX_WIDTH/QUALITY
      const img = await Jimp.fromBuffer(Buffer.from(uploaded.slice(uploaded.indexOf(",") + 1), "base64"));
      expect(img.bitmap.width).toBeGreaterThanOrEqual(MIN_ANALYSIS_WIDTH);
      expect(img.bitmap.height).toBeGreaterThanOrEqual(MIN_ANALYSIS_HEIGHT);
      expect(uploaded.length).toBeLessThan(1_500_000); // screenshot_data_url cap
      const out = await run(uploaded, true);
      expect(out.report.state).toBe("applied");
      console.log(
        `[M19A upload profile] 2560x1440 -> ${img.bitmap.width}x${img.bitmap.height}, ` +
          `${Math.round(uploaded.length / 1024)}KB base64, state=${out.report.state}, masked=${out.report.masked}`,
      );
    },
  );

  it(
    "low contrast and dark backgrounds still fail closed rather than falsely certify",
    { timeout: 600_000 },
    async () => {
      const dark = new Jimp({ width: 900, height: 500, color: 0x101010ff });
      const font = await loadFont(SANS_128_BLACK);
      const strip = new Jimp({ width: 2600, height: 170, color: 0x101010ff });
      strip.print({ font, x: 0, y: 0, text: SECRETS[0]! });
      strip.resize({ w: 500, h: 33 });
      dark.composite(strip, 40, 60);
      const buf = await dark.getBuffer(JimpMime.jpeg, { quality: 85 });
      const out = await run(`data:image/jpeg;base64,${buf.toString("base64")}`, true);
      // 900x500 is below the floor: uncertifiable regardless of what OCR sees.
      expect(out.report.state).toBe("blocked_strict");
    },
  );
});
