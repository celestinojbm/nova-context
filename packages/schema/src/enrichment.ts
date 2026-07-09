import { z } from "zod";
import { intentActionTypeSchema, intentPrioritySchema } from "./intent.js";

/**
 * Enrichment (M2): asynchronous, worker-produced understanding of a Context
 * Moment. Lifecycle on context_moments.enrichment_status:
 *   pending → processing → completed | failed
 *   skipped = no queue configured (or moment predates the worker).
 * The moment is fully usable in every state — enrichment only adds.
 */

export const enrichmentStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "skipped",
]);
export type EnrichmentStatus = z.infer<typeof enrichmentStatusSchema>;

export const enrichedEntitySchema = z.object({
  kind: z.enum(["person", "org", "topic", "url", "product", "other"]),
  name: z.string().min(1).max(256),
});
export type EnrichedEntity = z.infer<typeof enrichedEntitySchema>;

export const actionCandidateSchema = z.object({
  action_type: z.enum(["nova_task", "notion_page"]),
  title: z.string().min(1).max(512),
  detail: z.string().max(2000).nullable(),
  risk_tier: z.number().int().min(0).max(2),
});
export type ActionCandidate = z.infer<typeof actionCandidateSchema>;

/** Stored in context_moments.enrichment (jsonb). */
export const enrichmentResultSchema = z.object({
  tags: z.array(z.string().min(1).max(64)).max(12),
  priority_signal: intentPrioritySchema,
  action_candidates: z.array(actionCandidateSchema).max(5),
  project_candidates: z.array(
    z.object({ id: z.string().uuid(), name: z.string(), confidence: z.number() }),
  ),
  provider: z.enum(["heuristic", "llm"]),
  model: z.string().nullable(),
  embedded: z.boolean(),
});
export type EnrichmentResult = z.infer<typeof enrichmentResultSchema>;

/** What the enrichment providers produce before storage-side assembly. */
export const enrichmentDraftSchema = z.object({
  summary: z.string().min(1).max(1000),
  entities: z.array(enrichedEntitySchema).max(20),
  tags: z.array(z.string().min(1).max(64)).max(12),
  action_candidates: z.array(actionCandidateSchema).max(5),
  priority_signal: intentPrioritySchema,
  refined_action_type: intentActionTypeSchema.nullable(),
  provider: z.enum(["heuristic", "llm"]),
  model: z.string().nullable(),
});
export type EnrichmentDraft = z.infer<typeof enrichmentDraftSchema>;
