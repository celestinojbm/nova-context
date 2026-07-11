import { describe, expect, it } from "vitest";
import { sanitizeLegacyInlineMedia } from "./legacy-media.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

describe("sanitizeLegacyInlineMedia (Hermes D01)", () => {
  it("strips screenshot_data_url and flags exclusion", () => {
    const out = sanitizeLegacyInlineMedia({
      screenshot_data_url: DATA_URL,
      dom_extract: { main_text: "hello" },
    }) as Record<string, unknown>;
    expect(out.screenshot_data_url).toBeUndefined();
    expect(out.legacy_media_excluded).toBe(true);
    expect(out.legacy_media_detected).toBe(true);
    expect(out.excluded_reason).toBe("legacy_inline_media_not_verified");
    expect((out.dom_extract as { main_text: string }).main_text).toBe("hello");
    expect(JSON.stringify(out)).not.toContain("data:image");
  });

  it("strips nested and arrayed inline images anywhere in the payload", () => {
    const out = sanitizeLegacyInlineMedia({
      live_session: {
        qa: [{ question: "q", frame: DATA_URL }],
        frames: [DATA_URL, DATA_URL],
      },
      nested: { deep: { img: DATA_URL } },
    });
    expect(JSON.stringify(out)).not.toContain("data:image");
    expect((out as Record<string, unknown>).legacy_media_excluded).toBe(true);
  });

  it("leaves a clean payload untouched (no flags added)", () => {
    const clean = { dom_extract: { main_text: "no images here" }, headings: ["a"] };
    const out = sanitizeLegacyInlineMedia(clean) as Record<string, unknown>;
    expect(out.legacy_media_excluded).toBeUndefined();
    expect(out).toEqual(clean);
  });

  it("handles null/primitive payloads", () => {
    expect(sanitizeLegacyInlineMedia(null)).toBeNull();
    expect(sanitizeLegacyInlineMedia(undefined)).toBeUndefined();
    expect(sanitizeLegacyInlineMedia("x")).toBe("x");
  });

  // M15C (Hermes M15B-R01): detection MUST be case-insensitive. A data URI is
  // case-insensitive by spec, so mixed-case variants are inline images too.
  it("strips MIXED-CASE inline images (DATA:image, Data:Image, data:IMAGE/svg)", () => {
    const out = sanitizeLegacyInlineMedia({
      a: "DATA:image/png;base64,iVBORw0KGgoAAAANS",
      b: "Data:Image/png;base64,iVBORw0KGgoAAAANS",
      c: "data:IMAGE/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      keep: "just text",
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/data:image/i); // no case variant survives
    expect(s).not.toContain("<svg");
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
    expect(out.c).toBeUndefined();
    expect(out.keep).toBe("just text");
    expect(out.legacy_media_excluded).toBe(true);
    expect(out.excluded_reason).toBe("legacy_inline_media_not_verified");
  });

  it("strips a mixed-case value nested in objects and arrays", () => {
    const out = sanitizeLegacyInlineMedia({
      screenshot: "DATA:image/png;base64,AAAA",
      frames: ["Data:Image/jpeg;base64,BBBB", "keep-me"],
      deep: { thumb: "data:IMAGE/webp;base64,CCCC" },
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/data:image/i);
    expect(s).toContain("keep-me");
    expect(out.legacy_media_excluded).toBe(true);
  });

  it("drops a mixed-CASE screenshot key even without a data: value", () => {
    const out = sanitizeLegacyInlineMedia({
      Screenshot_Data_URL: "opaque-legacy-blob",
      note: "keep",
    }) as Record<string, unknown>;
    expect(out.Screenshot_Data_URL).toBeUndefined();
    expect(out.legacy_media_excluded).toBe(true);
    expect(out.note).toBe("keep");
  });
});
