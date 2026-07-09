import { framesAllowed, LiveBuffer, type CaptureMode } from "@nova/context-engine";
import { LIVE_LIMITS, type LiveAnswerResponse, type LiveQaExchange } from "@nova/schema";
import type { CreateContextMomentRequest } from "@nova/schema";
import { extractPageContext, downscaleDataUrl, type PageContext } from "./capture.js";
import type { ExtensionSettings } from "./api.js";

/**
 * Live Context Session controller (M3). Explicit lifecycle: the user starts
 * it, a visible indicator runs the whole time, and it ends on stop, on the
 * 30-minute hard cap, or when the side panel goes away — taking the buffer
 * with it. Frame sampling uses chrome.tabs.captureVisibleTab (the safest
 * available API needing no new permissions); no continuous video capture,
 * no audio, no background recording.
 */

const FRAME_INTERVAL_MS = 5_000;
const TEXT_INTERVAL_MS = 10_000;

export interface LiveSessionState {
  active: boolean;
  startedAt: number;
  remainingMs: number;
  frames: number;
  texts: number;
  bytes: number;
  qa: LiveQaExchange[];
  page: { url: string | null; title: string | null };
  lastError: string | null;
}

export class LiveSession {
  private buffer: LiveBuffer | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private textTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private tabId: number | null = null;
  private windowId: number | null = null;
  private page: PageContext | null = null;
  private lastError: string | null = null;
  onUpdate: (() => void) | null = null;
  onExpired: (() => void) | null = null;
  captureMode: CaptureMode = "full";

  get active(): boolean {
    return this.buffer !== null;
  }

  state(): LiveSessionState | null {
    if (!this.buffer) return null;
    const size = this.buffer.size();
    return {
      active: true,
      startedAt: this.buffer.startedAt,
      remainingMs: this.buffer.remainingMs(Date.now()),
      frames: size.frames,
      texts: size.texts,
      bytes: size.bytes,
      qa: this.buffer.recentQa(),
      page: { url: this.page?.url ?? null, title: this.page?.title ?? null },
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.buffer) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) throw new Error("No active tab for a live session.");
    this.tabId = tab.id;
    this.windowId = tab.windowId;
    this.buffer = new LiveBuffer(Date.now());
    this.lastError = null;

    await this.sampleText(); // immediate first samples
    await this.sampleFrame();

    this.frameTimer = setInterval(() => void this.sampleFrame(), FRAME_INTERVAL_MS);
    this.textTimer = setInterval(() => void this.sampleText(), TEXT_INTERVAL_MS);
    // Hard stop at the session cap — never runs longer, even if forgotten.
    this.expiryTimer = setTimeout(() => {
      this.stop();
      this.onExpired?.();
    }, LIVE_LIMITS.sessionMaxMs);
  }

  /** Ends the session and destroys the buffer. Only explicitly saved
   * moments (already POSTed) survive. */
  stop(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.textTimer) clearInterval(this.textTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.frameTimer = this.textTimer = this.expiryTimer = null;
    this.buffer?.clear();
    this.buffer = null;
    this.tabId = null;
    this.page = null;
  }

  private async sampleFrame(): Promise<void> {
    if (!this.buffer || this.windowId == null) return;
    if (this.buffer.expired(Date.now())) return;
    if (!framesAllowed(this.captureMode)) return; // text-only mode: no frames
    try {
      const raw = await chrome.tabs.captureVisibleTab(this.windowId, {
        format: "jpeg",
        quality: 60,
      });
      const small = await downscaleDataUrl(raw, 640, 0.6, this.captureMode === "blurred");
      this.buffer.addFrame(small, Date.now());
      this.lastError = null;
    } catch {
      // Permission lapse (navigation) or protected page: session continues
      // with text-only context; surfaced in the UI.
      this.lastError = "Frame capture unavailable — continuing with text only.";
    }
    this.onUpdate?.();
  }

  private async sampleText(): Promise<void> {
    if (!this.buffer || this.tabId == null) return;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: extractPageContext,
      });
      const page = injection?.result as PageContext | undefined;
      if (page) {
        this.page = page;
        this.buffer.addText(page.main_text, Date.now());
      }
    } catch {
      this.lastError = "Text extraction unavailable on this page.";
    }
    this.onUpdate?.();
  }

  /** Ask a question grounded in the current buffer. */
  async ask(settings: ExtensionSettings, question: string): Promise<LiveAnswerResponse> {
    if (!this.buffer) throw new Error("No active live session.");
    // Fresh frame at question time so the answer sees "now".
    await this.sampleFrame();
    const res = await fetch(`${settings.apiUrl}/v1/live/answers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiToken ? { authorization: `Bearer ${settings.apiToken}` } : {}),
      },
      body: JSON.stringify({
        question,
        context: {
          url: this.page?.url ?? null,
          title: this.page?.title ?? null,
          frames: this.buffer.recentFrames(),
          text_snippets: this.buffer.recentTextSnippets(),
          recent_qa: this.buffer.recentQa(),
          session_started_at: new Date(this.buffer.startedAt).toISOString(),
        },
      }),
    });
    if (res.status === 503) {
      throw new Error("Live Q&A is not enabled on the API (needs ANTHROPIC_API_KEY).");
    }
    if (!res.ok) throw new Error(`Live Q&A failed (${res.status}).`);
    const answer = (await res.json()) as LiveAnswerResponse;
    this.buffer.addQa({
      question,
      answer: answer.answer,
      at: new Date().toISOString(),
    });
    this.onUpdate?.();
    return answer;
  }

  /** Build a Context Moment from the current segment ("save this"). */
  buildSaveRequest(note: string, projectId: string | null): CreateContextMomentRequest {
    if (!this.buffer) throw new Error("No active live session.");
    const segment = this.buffer.saveSegment(Date.now());
    const latestText = segment.textSnippets[segment.textSnippets.length - 1] ?? "";
    const lastQa = segment.qa[segment.qa.length - 1];
    return {
      source_mode: "live_context",
      source_meta: {
        url: this.page?.url ?? undefined,
        title: this.page?.title || "Live session moment",
        viewport: this.page?.viewport,
      },
      payload: {
        dom_extract: { main_text: latestText || undefined },
        ...(segment.frame ? { screenshot_data_url: segment.frame } : {}),
        live_session: {
          started_at: new Date(segment.startedAt).toISOString(),
          saved_at: new Date(segment.savedAt).toISOString(),
          duration_ms: segment.durationMs,
          frame_count: segment.frameCount,
          qa: segment.qa,
        },
      },
      extracted_text: [this.page?.title, latestText].filter(Boolean).join(". "),
      intent_text:
        note.trim() ||
        (lastQa ? `Save this moment. Context: asked "${lastQa.question}"` : "Save this live moment"),
      project_id: projectId,
    };
  }
}
