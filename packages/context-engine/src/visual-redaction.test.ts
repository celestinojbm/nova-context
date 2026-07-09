import { Jimp, JimpMime } from "jimp";
import { describe, expect, it } from "vitest";
import {
  classifySensitiveWords,
  ImageRedactionError,
  parseDataUrl,
  redactImageDataUrl,
  type OcrEngine,
  type OcrWord,
} from "./visual-redaction.js";

/** Lay words out on one line, 100px wide each, 20px tall. */
function line(words: string[], y = 10): OcrWord[] {
  return words.map((text, i) => ({
    text,
    x0: i * 110,
    y0: y,
    x1: i * 110 + 100,
    y1: y + 20,
  }));
}

function fakeEngine(words: OcrWord[]): OcrEngine {
  return { name: "fake", recognize: async () => ({ words }) };
}

async function whiteImageDataUrl(w = 800, h = 200): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  const buf = await img.getBuffer(JimpMime.png);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

describe("classifySensitiveWords", () => {
  it("detects emails, phones, cards, keys, SSNs across words", () => {
    const words = [
      ...line(["Contact", "alice@example.com", "or", "(415)", "555-0134"], 10),
      ...line(["Card", "4111", "1111", "1111", "1111"], 50),
      ...line(["token", "sk-abcdefghijklmnop1234"], 90),
      ...line(["SSN", "078-05-1120"], 130),
    ];
    const { boxes, tally } = classifySensitiveWords(words);
    expect(tally["email"]).toBe(1);
    expect(tally["phone"]).toBe(1);
    expect(tally["card"]).toBe(1);
    expect(tally["api_key"]).toBe(1);
    expect(tally["ssn"]).toBe(1);
    // Every card fragment word gets its own box.
    const cardBoxes = boxes.filter((b) => b.type === "card");
    expect(cardBoxes.length).toBe(4);
    // Non-sensitive words are untouched.
    expect(boxes.some((b) => b.x0 === 0 && b.y0 === 10)).toBe(false); // "Contact"
  });

  it("detects labeled one-time codes but not bare numbers", () => {
    const labeled = classifySensitiveWords(line(["Your", "verification", "code", "is", "482913"]));
    expect(labeled.tally["auth_code"]).toBe(1);
    const bare = classifySensitiveWords(line(["Order", "total", "482913", "items"]));
    expect(bare.tally["auth_code"]).toBeUndefined();
  });

  it("detects conservative street addresses only", () => {
    const hit = classifySensitiveWords(line(["Ship", "to", "742", "Evergreen", "Terrace"]));
    expect(hit.tally["address"]).toBe(1);
    const miss = classifySensitiveWords(line(["chapter", "742", "of", "the", "saga"]));
    expect(miss.tally["address"]).toBeUndefined();
  });

  it("returns nothing for clean content", () => {
    const { boxes, tally } = classifySensitiveWords(
      line(["Quarterly", "report:", "revenue", "grew", "12%"]),
    );
    expect(boxes).toHaveLength(0);
    expect(tally).toEqual({});
  });
});

describe("redactImageDataUrl", () => {
  it("paints sensitive word boxes black and leaves the rest intact", async () => {
    const words = line(["email", "alice@example.com"], 40);
    const result = await redactImageDataUrl(fakeEngine(words), await whiteImageDataUrl());
    expect(result.masked).toBe(1);
    expect(result.tally["email"]).toBe(1);

    const { buffer } = parseDataUrl(result.dataUrl);
    const img = await Jimp.fromBuffer(buffer);
    // Inside the email box (word 2: x 110..210, y 40..60) → black.
    expect(img.getPixelColor(160, 50)).toBe(0x000000ff);
    // Inside the "email" label box (word 1) → still white.
    expect(img.getPixelColor(50, 50)).toBe(0xffffffff);
    // Far away → still white.
    expect(img.getPixelColor(700, 150)).toBe(0xffffffff);
  });

  it("returns the original data URL untouched when nothing is sensitive", async () => {
    const original = await whiteImageDataUrl(100, 50);
    const result = await redactImageDataUrl(
      fakeEngine(line(["hello", "world"])),
      original,
    );
    expect(result.masked).toBe(0);
    expect(result.dataUrl).toBe(original);
  });

  it("throws ImageRedactionError when OCR fails (caller applies fail-safe)", async () => {
    const failing: OcrEngine = {
      name: "boom",
      recognize: async () => {
        throw new Error("engine crashed");
      },
    };
    await expect(
      redactImageDataUrl(failing, await whiteImageDataUrl(50, 50)),
    ).rejects.toThrow(ImageRedactionError);
  });

  it("rejects non-image data URLs", () => {
    expect(() => parseDataUrl("data:text/plain;base64,aGk=")).toThrow(ImageRedactionError);
    expect(() => parseDataUrl("http://example.com/x.png")).toThrow(ImageRedactionError);
  });
});
