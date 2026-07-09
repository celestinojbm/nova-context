import { z } from "zod";
import { parsedIntentSchema, projectSuggestionSchema } from "./intent.js";

/**
 * Contracts for the Context Moment ingestion path (M0 surface).
 * These mirror the request/response shapes in docs/BUILD_PLAN.md §5 and the
 * context_moments DDL in §4. Fields that only exist after enrichment
 * (summary, suggested_projects) are present but null/empty in M0.
 */

export const sourceModeSchema = z.enum(["instant_capture", "live_context"]);
export type SourceMode = z.infer<typeof sourceModeSchema>;

export const sourceMetaSchema = z
  .object({
    url: z.string().url().max(4096).optional(),
    title: z.string().max(1024).optional(),
    favicon: z.string().max(4096).optional(),
    app: z.string().max(256).optional(),
    viewport: z
      .object({ w: z.number().int().positive(), h: z.number().int().positive() })
      .optional(),
  })
  .strict();
export type SourceMeta = z.infer<typeof sourceMetaSchema>;

/**
 * The normalized capture draft. dom_extract carries what the content script
 * pulled from the page; screenshot_data_url is the M0 stand-in for object
 * storage (a downscaled JPEG data URL — see the size cap below). It moves to
 * moment_media + S3-compatible storage in M2.
 */
export const capturePayloadSchema = z
  .object({
    dom_extract: z
      .object({
        main_text: z.string().max(100_000).optional(),
        selected_text: z.string().max(20_000).nullable().optional(),
        meta_description: z.string().max(2_000).optional(),
        headings: z.array(z.string().max(512)).max(100).optional(),
      })
      .optional(),
    // ~1.5MB base64 hard cap keeps a jsonb row reasonable for the M0 skeleton.
    screenshot_data_url: z
      .string()
      .regex(/^data:image\/(jpeg|png|webp);base64,/)
      .max(1_500_000)
      .optional(),
  })
  .passthrough();
export type CapturePayload = z.infer<typeof capturePayloadSchema>;

export const createContextMomentRequestSchema = z
  .object({
    source_mode: sourceModeSchema,
    source_meta: sourceMetaSchema.default({}),
    payload: capturePayloadSchema.default({}),
    extracted_text: z.string().max(200_000).nullable().optional(),
    intent_text: z.string().max(10_000).nullable().optional(),
    project_id: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateContextMomentRequest = z.infer<
  typeof createContextMomentRequestSchema
>;

export const contextMomentSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  source_mode: sourceModeSchema,
  source_meta: sourceMetaSchema,
  payload: capturePayloadSchema,
  extracted_text: z.string().nullable(),
  intent_text: z.string().nullable(),
  summary: z.string().nullable(),
  captured_at: z.string().datetime({ offset: true }),
  redaction_state: z.enum(["pending", "applied", "skipped"]),
  // M1: structured intent stored with the moment; null when no intent_text
  // was provided or the moment predates intent parsing.
  intent_parsed: parsedIntentSchema.nullable().optional(),
});
export type ContextMoment = z.infer<typeof contextMomentSchema>;

export const createContextMomentResponseSchema = contextMomentSchema
  .pick({
    id: true,
    project_id: true,
    summary: true,
    captured_at: true,
    redaction_state: true,
  })
  .extend({
    // Async enrichment (summary, entities, embeddings) arrives in M2; status
    // is reported honestly so clients written now keep working then.
    enrichment: z.object({
      status: z.enum(["queued", "done", "skipped"]),
      job_id: z.string().nullable(),
    }),
    suggested_projects: z.array(projectSuggestionSchema),
    links: z.object({ self: z.string() }),
    // M1: intent parsed synchronously at capture; null when no intent_text.
    intent: parsedIntentSchema.nullable(),
    // M1: Tier-0 auto-executed task, when the intent called for one.
    task: z
      .object({ id: z.string().uuid(), title: z.string() })
      .nullable(),
  });
export type CreateContextMomentResponse = z.infer<
  typeof createContextMomentResponseSchema
>;

export const listContextMomentsResponseSchema = z.object({
  items: z.array(contextMomentSchema),
  next_before: z.string().datetime({ offset: true }).nullable(),
});
export type ListContextMomentsResponse = z.infer<
  typeof listContextMomentsResponseSchema
>;
