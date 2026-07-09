import { z } from "zod";

/**
 * Parsed intent (M1): the structured interpretation of the user's spoken or
 * typed instruction, stored on the Context Moment (context_moments.intent_parsed).
 * Produced by @nova/model-router — an LLM parser when a provider key is
 * configured, always falling back to the deterministic heuristic parser.
 */

export const intentActionTypeSchema = z.enum([
  "create_task",
  "remind_follow_up",
  "save_reference",
  "research",
  "unknown",
]);
export type IntentActionType = z.infer<typeof intentActionTypeSchema>;

export const intentPrioritySchema = z.enum(["low", "normal", "high"]);
export type IntentPriority = z.infer<typeof intentPrioritySchema>;

export const parsedIntentSchema = z.object({
  action_type: intentActionTypeSchema,
  // The project the user referenced by name, if any ("...for the pricing project").
  project_hint: z.string().min(1).max(256).nullable(),
  // One-line restatement of what the user wants, usable as a task title.
  summary: z.string().min(1).max(512),
  priority_guess: intentPrioritySchema,
  confidence: z.number().min(0).max(1),
  // Which parser produced this — kept for audit and benchmarking.
  parser: z.enum(["heuristic", "llm"]),
  model: z.string().nullable(),
});
export type ParsedIntent = z.infer<typeof parsedIntentSchema>;

export const projectSuggestionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type ProjectSuggestion = z.infer<typeof projectSuggestionSchema>;

export const suggestProjectsRequestSchema = z
  .object({
    intent_text: z.string().max(10_000).nullable().optional(),
    url: z.string().url().max(4096).nullable().optional(),
  })
  .strict();
export type SuggestProjectsRequest = z.infer<typeof suggestProjectsRequestSchema>;

export const suggestProjectsResponseSchema = z.object({
  suggestions: z.array(projectSuggestionSchema),
});
export type SuggestProjectsResponse = z.infer<typeof suggestProjectsResponseSchema>;

export const transcriptionResponseSchema = z.object({
  transcript: z.string(),
  provider: z.string(),
});
export type TranscriptionResponse = z.infer<typeof transcriptionResponseSchema>;
