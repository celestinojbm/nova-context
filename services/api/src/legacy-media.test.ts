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
});
