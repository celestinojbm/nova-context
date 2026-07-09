import { z } from "zod";

/**
 * Live Context Mode v0 (M3). Sessions are CLIENT-side: the ring buffer lives
 * in the extension's side panel and dies with the session (docs/CONTEXT_BUFFER.md
 * — never uploaded wholesale). The server sees only:
 *   - stateless Q&A requests carrying a minimized slice of the buffer, and
 *   - explicitly saved moments (source_mode 'live_context').
 */

/** Hard limits, shared between the client buffer and server validation. */
export const LIVE_LIMITS = {
  sessionMaxMs: 30 * 60 * 1000, // 30-minute hard cap (BUILD_PLAN M3)
  bufferWindowMs: 90 * 1000, // rolling window of frames/text kept
  maxFrames: 12, // ring capacity for sampled frames
  maxFrameBytes: 400_000, // per downscaled frame (base64)
  maxBufferBytes: 6_000_000, // total buffer budget; drop-oldest beyond
  maxTextSnippets: 12,
  maxQaExchanges: 10,
  qaFramesPerRequest: 3, // most recent frames sent with a question
} as const;

export const liveQaExchangeSchema = z.object({
  question: z.string().max(2000),
  answer: z.string().max(8000),
  at: z.string().datetime({ offset: true }),
});
export type LiveQaExchange = z.infer<typeof liveQaExchangeSchema>;

/** Minimized live-buffer slice sent with a question. Data, not instructions. */
export const liveAnswerRequestSchema = z
  .object({
    question: z.string().min(1).max(2000),
    context: z
      .object({
        url: z.string().url().max(4096).nullable().optional(),
        title: z.string().max(1024).nullable().optional(),
        // Most recent sampled frames (downscaled JPEG data URLs).
        frames: z
          .array(
            z
              .string()
              .regex(/^data:image\/(jpeg|png|webp);base64,/)
              .max(LIVE_LIMITS.maxFrameBytes),
          )
          .max(LIVE_LIMITS.qaFramesPerRequest)
          .default([]),
        // Recent visible-text snippets, oldest first.
        text_snippets: z
          .array(z.string().max(20_000))
          .max(LIVE_LIMITS.maxTextSnippets)
          .default([]),
        recent_qa: z.array(liveQaExchangeSchema).max(LIVE_LIMITS.maxQaExchanges).default([]),
        session_started_at: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .default({}),
  })
  .strict();
export type LiveAnswerRequest = z.infer<typeof liveAnswerRequestSchema>;

export const liveAnswerResponseSchema = z.object({
  answer: z.string(),
  // 'grounded' = answered from the provided context; 'insufficient_context'
  // = the model said it cannot answer from what it can see (never invents).
  grounding: z.enum(["grounded", "insufficient_context"]),
  model: z.string().nullable(),
});
export type LiveAnswerResponse = z.infer<typeof liveAnswerResponseSchema>;

/** Stored on payload.live_session of a saved live-context moment. */
export const liveSessionMetaSchema = z.object({
  started_at: z.string().datetime({ offset: true }),
  saved_at: z.string().datetime({ offset: true }),
  duration_ms: z.number().int().min(0),
  frame_count: z.number().int().min(0),
  qa: z.array(liveQaExchangeSchema).max(LIVE_LIMITS.maxQaExchanges),
});
export type LiveSessionMeta = z.infer<typeof liveSessionMetaSchema>;
