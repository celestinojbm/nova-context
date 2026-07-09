import { z } from "zod";
import { contextMomentSchema } from "./context-moment.js";
import { enrichmentStatusSchema } from "./enrichment.js";
import { intentActionTypeSchema, intentPrioritySchema } from "./intent.js";

/**
 * Hybrid memory search (M2): Postgres full-text + pgvector cosine when
 * embeddings exist, fused; all filters apply to both legs. With no query
 * text it degrades to a filtered, recency-ordered listing.
 */

export const memorySearchRequestSchema = z
  .object({
    query: z.string().max(1000).nullable().optional(),
    project_id: z.string().uuid().optional(),
    domain: z.string().max(256).optional(),
    action_type: intentActionTypeSchema.optional(),
    priority: intentPrioritySchema.optional(),
    enrichment_status: enrichmentStatusSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;

export const memorySearchResultSchema = contextMomentSchema.extend({
  score: z.number(),
  match: z.enum(["fts", "vector", "both", "filter"]),
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

export const memorySearchResponseSchema = z.object({
  items: z.array(memorySearchResultSchema),
  // Which search legs actually ran, so clients can explain result quality.
  legs: z.object({ fts: z.boolean(), vector: z.boolean() }),
});
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;
