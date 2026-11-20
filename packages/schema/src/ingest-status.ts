import { z } from "zod";

/**
 * Visible ingest/enrichment status for a saved Context Moment (Zep
 * `wait_status` analog). Stored `enrichment_status` is unchanged:
 * `expired` is computed at read time and never written back.
 *
 * Queryable by `project_id` (the grouping that exists in main). Memory
 * namespaces (M20b) can be added later as an extra filter.
 */
export const INGEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ingestWaitReasonSchema = z.enum([
  "queued",
  "processing",
  "rate_limit",
  "waiting_capacity",
  "delayed",
]);
export type IngestWaitReason = z.infer<typeof ingestWaitReasonSchema>;

export const visibleIngestStatusSchema = z.enum(["pending", "failed", "expired"]);
export type VisibleIngestStatus = z.infer<typeof visibleIngestStatusSchema>;

export interface IngestStatusRow {
  enrichment_status: string;
  enrichment_wait_reason?: string | null;
  enrichment_error_code?: string | null;
  enrichment_error?: string | null;
  enrichment_expires_at?: Date | string | null;
  captured_at: Date | string;
}

export interface VisibleIngest {
  status: VisibleIngestStatus | null;
  wait_reason: IngestWaitReason | null;
  error_code: string | null;
  error_message: string | null;
  expires_at: string;
}

function toMs(value: Date | string): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function expiresAt(row: IngestStatusRow): string {
  if (row.enrichment_expires_at) return toIso(row.enrichment_expires_at);
  return new Date(toMs(row.captured_at) + INGEST_TTL_MS).toISOString();
}

function asWaitReason(value: string | null | undefined, fallback: IngestWaitReason): IngestWaitReason {
  const parsed = ingestWaitReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Derive the client-visible ingest status. Does not mutate storage. */
export function visibleIngest(row: IngestStatusRow, now = Date.now()): VisibleIngest {
  const expires = expiresAt(row);
  if (row.enrichment_status === "failed") {
    return {
      status: "failed",
      wait_reason: null,
      error_code: row.enrichment_error_code ?? "enrichment_failed",
      error_message: row.enrichment_error ?? null,
      expires_at: expires,
    };
  }
  if (row.enrichment_status === "pending" || row.enrichment_status === "processing") {
    const fallback: IngestWaitReason = row.enrichment_status === "processing" ? "processing" : "queued";
    const wait = asWaitReason(row.enrichment_wait_reason, fallback);
    if (now >= Date.parse(expires)) {
      return { status: "expired", wait_reason: wait, error_code: null, error_message: null, expires_at: expires };
    }
    return { status: "pending", wait_reason: wait, error_code: null, error_message: null, expires_at: expires };
  }
  return { status: null, wait_reason: null, error_code: null, error_message: null, expires_at: expires };
}

export const ingestStatusQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  status: visibleIngestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type IngestStatusQuery = z.infer<typeof ingestStatusQuerySchema>;

export const ingestStatusItemSchema = z.object({
  moment_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  status: visibleIngestStatusSchema,
  wait_reason: ingestWaitReasonSchema.nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  captured_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
});
export type IngestStatusItem = z.infer<typeof ingestStatusItemSchema>;

export const ingestStatusResponseSchema = z.object({
  items: z.array(ingestStatusItemSchema),
});
export type IngestStatusResponse = z.infer<typeof ingestStatusResponseSchema>;
