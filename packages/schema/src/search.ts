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
    // M8: filter by media presence and/or the visual-redaction outcome the
    // media was stored under.
    has_media: z.boolean().optional(),
    image_redaction_state: z
      .enum(["applied", "failed", "skipped", "blocked_strict", "storage_disabled", "media_unavailable", "none"])
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
    // M9: include per-item ranking diagnostics (raw leg scores). The user's
    // own data only — this explains ranking, it exposes nothing new.
    debug: z.boolean().optional(),
  })
  .strict();
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;

/** M9: raw leg scores behind an item's fused score (debug: true). */
export interface SearchDiagnostics {
  fts_rank: number | null;
  vector_similarity: number | null;
  /** True when the item matched only via the M9 prefix fallback. */
  prefix_fallback: boolean;
}

export const memorySearchResultSchema = contextMomentSchema.extend({
  score: z.number(),
  match: z.enum(["fts", "vector", "both", "filter"]),
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema> & {
  diagnostics?: SearchDiagnostics;
};

export const memorySearchResponseSchema = z.object({
  items: z.array(memorySearchResultSchema),
  // Which search legs actually ran, so clients can explain result quality.
  legs: z.object({ fts: z.boolean(), vector: z.boolean() }),
});
export type MemorySearchResponse = {
  items: MemorySearchResult[];
  legs: { fts: boolean; vector: boolean; prefix_fallback?: boolean };
};
