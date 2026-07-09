import { describe, expect, it } from "vitest";
import { LiveBuffer } from "./live-buffer.js";

const T0 = 1_000_000;
const frame = (n: number) => `data:image/jpeg;base64,${"A".repeat(n)}`;

describe("LiveBuffer", () => {
  it("starts empty and clears to empty (nothing survives a session)", () => {
    const buf = new LiveBuffer(T0);
    buf.addFrame(frame(100), T0 + 1000);
    buf.addText("visible text", T0 + 1000);
    buf.addQa({ question: "q", answer: "a", at: new Date().toISOString() });
    expect(buf.size().entries).toBe(2);
    buf.clear();
    expect(buf.size()).toEqual({ entries: 0, frames: 0, texts: 0, qa: 0, bytes: 0 });
  });

  it("enforces the hard session duration cap", () => {
    const buf = new LiveBuffer(T0, { sessionMaxMs: 10_000 });
    expect(buf.expired(T0 + 9_999)).toBe(false);
    expect(buf.expired(T0 + 10_000)).toBe(true);
    expect(buf.remainingMs(T0 + 4_000)).toBe(6_000);
    expect(buf.remainingMs(T0 + 20_000)).toBe(0);
  });

  it("evicts entries outside the rolling window", () => {
    const buf = new LiveBuffer(T0, { bufferWindowMs: 10_000 });
    buf.addFrame(frame(10), T0 + 1_000);
    buf.addText("old text", T0 + 1_200);
    buf.addFrame(frame(10), T0 + 11_500); // cutoff = +1_500 → first two evicted
    expect(buf.size().frames).toBe(1);
    expect(buf.size().texts).toBe(0);
  });

  it("caps frame count with drop-oldest", () => {
    const buf = new LiveBuffer(T0, { maxFrames: 3, bufferWindowMs: 1e9 });
    for (let i = 0; i < 6; i++) buf.addFrame(frame(10 + i), T0 + i);
    expect(buf.size().frames).toBe(3);
    // Newest survive.
    expect(buf.recentFrames(3)[2]).toBe(frame(15));
  });

  it("enforces the total byte budget with drop-oldest", () => {
    const buf = new LiveBuffer(T0, {
      maxBufferBytes: 1_000,
      maxFrameBytes: 600,
      bufferWindowMs: 1e9,
    });
    buf.addFrame(frame(400), T0 + 1); // ~423 bytes
    buf.addFrame(frame(400), T0 + 2);
    buf.addFrame(frame(400), T0 + 3); // exceeds 1000 → oldest dropped
    expect(buf.totalBytes()).toBeLessThanOrEqual(1_000);
    expect(buf.size().frames).toBe(2);
  });

  it("drops oversized frames instead of buffering them", () => {
    const buf = new LiveBuffer(T0, { maxFrameBytes: 100 });
    buf.addFrame(frame(500), T0 + 1);
    expect(buf.size().frames).toBe(0);
  });

  it("dedupes consecutive identical text snapshots and caps snippets", () => {
    const buf = new LiveBuffer(T0, { maxTextSnippets: 2, bufferWindowMs: 1e9 });
    buf.addText("same", T0 + 1);
    buf.addText("same", T0 + 2);
    expect(buf.size().texts).toBe(1);
    buf.addText("two", T0 + 3);
    buf.addText("three", T0 + 4);
    expect(buf.size().texts).toBe(2);
    expect(buf.recentTextSnippets()).toEqual(["two", "three"]);
  });

  it("caps Q&A history", () => {
    const buf = new LiveBuffer(T0, { maxQaExchanges: 2 });
    for (let i = 0; i < 4; i++) {
      buf.addQa({ question: `q${i}`, answer: `a${i}`, at: new Date().toISOString() });
    }
    expect(buf.recentQa().map((x) => x.question)).toEqual(["q2", "q3"]);
  });

  it("saveSegment snapshots the latest frame/text/qa without clearing", () => {
    const buf = new LiveBuffer(T0);
    buf.addFrame(frame(10), T0 + 1_000);
    buf.addFrame(frame(20), T0 + 2_000);
    buf.addText("what is on screen", T0 + 2_500);
    buf.addQa({ question: "what is this?", answer: "a demo", at: new Date().toISOString() });

    const segment = buf.saveSegment(T0 + 3_000);
    expect(segment.frame).toBe(frame(20)); // latest frame
    expect(segment.textSnippets).toEqual(["what is on screen"]);
    expect(segment.qa).toHaveLength(1);
    expect(segment.durationMs).toBe(3_000);
    expect(segment.frameCount).toBe(2);
    // Session continues; buffer intact.
    expect(buf.size().frames).toBe(2);
  });
});
