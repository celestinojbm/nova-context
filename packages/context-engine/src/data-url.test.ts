import { describe, expect, it } from "vitest";
import { isDataUrl, isImageDataUrl } from "./data-url.js";

/**
 * M15C (Hermes M15B-R01): inline-image detection is the single gate every
 * sanitizer/extraction path relies on. A data URI is case-insensitive by
 * spec, so detection must be too — a case-sensitive check let mixed-case
 * variants bypass the legacy-media sanitizer and leak.
 */
describe("isImageDataUrl (canonical, case-insensitive)", () => {
  it("matches every case variant of an image data URI", () => {
    for (const v of [
      "data:image/png;base64,AAAA",
      "DATA:image/png;base64,AAAA",
      "Data:Image/png;base64,AAAA",
      "data:IMAGE/svg+xml,<svg></svg>",
      "DATA:IMAGE/JPEG;base64,AAAA",
      "  data:image/webp;base64,AAAA", // tolerates leading whitespace
    ]) {
      expect(isImageDataUrl(v)).toBe(true);
    }
  });

  it("does not match non-image or non-data strings", () => {
    for (const v of [
      "data:text/html;base64,PHNjcmlwdD4=",
      "https://example.com/a.png",
      "not a data url",
      "image/png",
      "",
      123,
      null,
      undefined,
      { data: "image" },
    ]) {
      expect(isImageDataUrl(v)).toBe(false);
    }
  });
});

describe("isDataUrl (any scheme, case-insensitive)", () => {
  it("matches any-case data URIs, image or not", () => {
    expect(isDataUrl("DATA:text/html,<b>")).toBe(true);
    expect(isDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isDataUrl("https://x/y")).toBe(false);
  });
});
