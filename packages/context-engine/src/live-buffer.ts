import { LIVE_LIMITS, type LiveQaExchange } from "@nova/schema";

/**
 * Live Context Buffer (M3 — docs/CONTEXT_BUFFER.md). A bounded, in-memory
 * ring buffer for one explicit live session. Pure data structure: the
 * extension feeds it sampled frames/text and Q&A; nothing here persists
 * anything. Guarantees, enforced and unit-tested:
 *   - hard session duration cap (LIVE_LIMITS.sessionMaxMs)
 *   - rolling window: entries older than bufferWindowMs are evicted
 *     (Q&A exchanges are kept for the whole session, capped by count)
 *   - frame count + total byte budget with drop-oldest
 *   - clear() wipes everything; nothing survives the session object
 */

export interface FrameEntry {
  kind: "frame";
  at: number;
  dataUrl: string;
  bytes: number;
}

export interface TextEntry {
  kind: "text";
  at: number;
  text: string;
  bytes: number;
}

export type BufferEntry = FrameEntry | TextEntry;

export interface SavedSegment {
  frame: string | null;
  textSnippets: string[];
  qa: LiveQaExchange[];
  startedAt: number;
  savedAt: number;
  durationMs: number;
  frameCount: number;
}

export class LiveBuffer {
  private entries: BufferEntry[] = [];
  private qa: LiveQaExchange[] = [];
  readonly startedAt: number;
  private readonly limits: typeof LIVE_LIMITS;

  constructor(
    startedAt: number,
    limits: Partial<typeof LIVE_LIMITS> = {},
  ) {
    this.startedAt = startedAt;
    this.limits = { ...LIVE_LIMITS, ...limits };
  }

  /** True once the hard session cap is reached — callers must stop. */
  expired(now: number): boolean {
    return now - this.startedAt >= this.limits.sessionMaxMs;
  }

  remainingMs(now: number): number {
    return Math.max(0, this.limits.sessionMaxMs - (now - this.startedAt));
  }

  addFrame(dataUrl: string, now: number): void {
    if (dataUrl.length > this.limits.maxFrameBytes) return; // oversized: drop
    this.entries.push({ kind: "frame", at: now, dataUrl, bytes: dataUrl.length });
    this.evict(now);
  }

  addText(text: string, now: number): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Skip if identical to the latest snippet (pages rarely change per tick).
    const lastText = [...this.entries].reverse().find((e) => e.kind === "text");
    if (lastText && (lastText as TextEntry).text === trimmed) return;
    this.entries.push({ kind: "text", at: now, text: trimmed, bytes: trimmed.length });
    this.evict(now);
  }

  addQa(exchange: LiveQaExchange): void {
    this.qa.push(exchange);
    if (this.qa.length > this.limits.maxQaExchanges) {
      this.qa = this.qa.slice(-this.limits.maxQaExchanges);
    }
  }

  private evict(now: number): void {
    // 1. Rolling time window.
    const cutoff = now - this.limits.bufferWindowMs;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    // 2. Frame count cap (drop oldest frames).
    let frames = this.entries.filter((e) => e.kind === "frame");
    while (frames.length > this.limits.maxFrames) {
      const oldest = frames[0]!;
      this.entries.splice(this.entries.indexOf(oldest), 1);
      frames = this.entries.filter((e) => e.kind === "frame");
    }
    // 3. Text snippet cap.
    let texts = this.entries.filter((e) => e.kind === "text");
    while (texts.length > this.limits.maxTextSnippets) {
      const oldest = texts[0]!;
      this.entries.splice(this.entries.indexOf(oldest), 1);
      texts = this.entries.filter((e) => e.kind === "text");
    }
    // 4. Total byte budget (drop oldest of any kind).
    while (this.totalBytes() > this.limits.maxBufferBytes && this.entries.length > 0) {
      this.entries.shift();
    }
  }

  totalBytes(): number {
    return this.entries.reduce((n, e) => n + e.bytes, 0);
  }

  frameCount(): number {
    return this.entries.filter((e) => e.kind === "frame").length;
  }

  /** Newest-last frames for a Q&A request (bounded). */
  recentFrames(max: number = this.limits.qaFramesPerRequest): string[] {
    return this.entries
      .filter((e): e is FrameEntry => e.kind === "frame")
      .slice(-max)
      .map((f) => f.dataUrl);
  }

  recentTextSnippets(max: number = this.limits.maxTextSnippets): string[] {
    return this.entries
      .filter((e): e is TextEntry => e.kind === "text")
      .slice(-max)
      .map((t) => t.text);
  }

  recentQa(): LiveQaExchange[] {
    return [...this.qa];
  }

  /** Snapshot the segment the user asked to save. Buffer is NOT cleared —
   * the session continues; only this snapshot leaves the buffer. */
  saveSegment(now: number): SavedSegment {
    const frames = this.recentFrames(1);
    return {
      frame: frames[frames.length - 1] ?? null,
      textSnippets: this.recentTextSnippets(3),
      qa: this.recentQa().slice(-3),
      startedAt: this.startedAt,
      savedAt: now,
      durationMs: now - this.startedAt,
      frameCount: this.frameCount(),
    };
  }

  /** Session end: everything goes. Nothing survives except moments the user
   * explicitly saved (already sent to the API by then). */
  clear(): void {
    this.entries = [];
    this.qa = [];
  }

  size(): { entries: number; frames: number; texts: number; qa: number; bytes: number } {
    return {
      entries: this.entries.length,
      frames: this.frameCount(),
      texts: this.entries.filter((e) => e.kind === "text").length,
      qa: this.qa.length,
      bytes: this.totalBytes(),
    };
  }
}
