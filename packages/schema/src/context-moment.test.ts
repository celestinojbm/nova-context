import { describe, expect, it } from "vitest";
import {
  capturePayloadSchema,
  createContextMomentRequestSchema,
} from "./context-moment.js";

const validRequest = {
  source_mode: "instant_capture",
  source_meta: {
    url: "https://example.com/pricing",
    title: "Pricing — Example",
    viewport: { w: 1440, h: 900 },
  },
  payload: {
    dom_extract: {
      main_text: "Enterprise plans start at ...",
      selected_text: null,
      headings: ["Pricing", "Enterprise"],
    },
    screenshot_data_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
  },
  extracted_text: "Pricing — Example. Enterprise plans start at ...",
  intent_text: "remember this for the pricing project",
};

describe("createContextMomentRequestSchema", () => {
  it("accepts a valid instant-capture request", () => {
    const parsed = createContextMomentRequestSchema.parse(validRequest);
    expect(parsed.source_mode).toBe("instant_capture");
    expect(parsed.source_meta.title).toBe("Pricing — Example");
  });

  it("defaults source_meta and payload when omitted", () => {
    const parsed = createContextMomentRequestSchema.parse({
      source_mode: "instant_capture",
    });
    expect(parsed.source_meta).toEqual({});
    expect(parsed.payload).toEqual({});
  });

  it("rejects an unknown source_mode", () => {
    expect(() =>
      createContextMomentRequestSchema.parse({
        ...validRequest,
        source_mode: "ambient_surveillance",
      }),
    ).toThrow();
  });

  it("rejects unknown top-level keys (strict contract)", () => {
    expect(() =>
      createContextMomentRequestSchema.parse({
        ...validRequest,
        admin: true,
      }),
    ).toThrow();
  });

  it("rejects a non-image screenshot data URL", () => {
    expect(() =>
      capturePayloadSchema.parse({
        screenshot_data_url: "data:text/html;base64,PHNjcmlwdD4=",
      }),
    ).toThrow();
  });

  it("rejects an invalid source_meta url", () => {
    expect(() =>
      createContextMomentRequestSchema.parse({
        ...validRequest,
        source_meta: { url: "not-a-url" },
      }),
    ).toThrow();
  });

  it("rejects a project_id that is not a uuid", () => {
    expect(() =>
      createContextMomentRequestSchema.parse({
        ...validRequest,
        project_id: "pricing",
      }),
    ).toThrow();
  });
});
