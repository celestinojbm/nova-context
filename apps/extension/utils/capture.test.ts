import {
  MIN_ANALYSIS_HEIGHT,
  MIN_ANALYSIS_WIDTH,
} from "@nova/context-engine/visual-redaction";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_MAX_WIDTH,
  CAPTURE_QUALITY,
  LIVE_FRAME_MAX_WIDTH,
  LIVE_FRAME_QUALITY,
  MIN_CAPTURE_HEIGHT,
  MIN_CAPTURE_WIDTH,
} from "./capture.js";

/**
 * M19A (Hermes D-10). The extension bundle cannot import the Node-only jimp
 * module, so the server's analysis-resolution floor is DUPLICATED in
 * capture.ts. A duplicated constant that silently drifts is worse than no
 * constant: the client would keep uploading captures the server refuses to
 * certify, and every screenshot would be dropped with no obvious cause.
 * These tests are the pin.
 */
describe("M19A capture constants track the server floor", () => {
  it("mirrors MIN_ANALYSIS_WIDTH / MIN_ANALYSIS_HEIGHT exactly", () => {
    expect(MIN_CAPTURE_WIDTH).toBe(MIN_ANALYSIS_WIDTH);
    expect(MIN_CAPTURE_HEIGHT).toBe(MIN_ANALYSIS_HEIGHT);
  });

  it("uploads captures wide enough to clear the floor", () => {
    // downscaleDataUrl only ever shrinks (scale = min(1, maxWidth/width)), so
    // the upload width is the cap — it must sit at or above the floor.
    expect(CAPTURE_MAX_WIDTH).toBeGreaterThanOrEqual(MIN_ANALYSIS_WIDTH);
    expect(LIVE_FRAME_MAX_WIDTH).toBeGreaterThanOrEqual(MIN_ANALYSIS_WIDTH);
  });

  it("keeps re-encode quality high enough for OCR to read body text", () => {
    // Below roughly 0.5 JPEG quality, glyph edges smear enough to cost real
    // recall — the point of raising the resolution is lost if we then crush
    // the bytes. Live frames trade a little quality for the buffer budget.
    expect(CAPTURE_QUALITY).toBeGreaterThanOrEqual(0.7);
    expect(LIVE_FRAME_QUALITY).toBeGreaterThanOrEqual(0.5);
  });
});
