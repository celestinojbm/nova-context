import { redactImageDataUrl } from "@nova/context-engine/visual-redaction";
import { Jimp, JimpMime, loadFont } from "jimp";
import { SANS_32_BLACK } from "jimp/fonts";
import { describe, expect, it } from "vitest";
import { TesseractOcrEngine } from "../../src/ocr.js";

/**
 * Real-OCR end-to-end proof (M7): render sensitive text into an image with
 * a bitmap font, run ACTUAL Tesseract, and verify the regions get masked.
 *
 * Gated behind NOVA_OCR_E2E=1 because Tesseract downloads ~2MB of language
 * data on first run (CDN or NOVA_OCR_LANG_PATH) — CI stays deterministic
 * with the fake-engine suites; run this locally:
 *
 *   NOVA_OCR_E2E=1 DATABASE_URL=... pnpm --filter @nova/api test:integration
 */
const enabled = process.env.NOVA_OCR_E2E === "1";

describe.skipIf(!enabled)("M7: real Tesseract OCR e2e", () => {
  it(
    "detects and masks an email and a card number rendered into an image",
    { timeout: 120_000 },
    async () => {
      const img = new Jimp({ width: 1000, height: 260, color: 0xffffffff });
      const font = await loadFont(SANS_32_BLACK);
      img.print({ font, x: 20, y: 40, text: "contact alice@example.com now" });
      img.print({ font, x: 20, y: 120, text: "card 4111 1111 1111 1111" });
      const dataUrl = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;

      const engine = new TesseractOcrEngine({ timeoutMs: 90_000 });
      try {
        const result = await redactImageDataUrl(engine, dataUrl);
        expect(result.masked).toBeGreaterThan(0);
        expect(
          (result.tally["email"] ?? 0) + (result.tally["card"] ?? 0),
        ).toBeGreaterThan(0);

        // Re-OCR the masked image: the sensitive strings must be gone.
        const rescan = await engine.recognize(
          Buffer.from(result.dataUrl.split(",")[1]!, "base64"),
        );
        const text = rescan.words.map((w) => w.text).join(" ");
        expect(text).not.toContain("alice@example.com");
        expect(text.replace(/\D/g, "")).not.toContain("4111111111111111");
      } finally {
        await engine.close();
      }
    },
  );
});
