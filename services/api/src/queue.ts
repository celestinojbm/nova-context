import { Queue } from "bullmq";

/**
 * Enrichment queue (M2). Shared contract with services/worker: queue name,
 * job payload, and retry policy live here on the producer side and are
 * mirrored by the worker's processor registration.
 */
export const ENRICHMENT_QUEUE = "moment-enrichment";

export interface EnrichmentJob {
  momentId: string;
  userId: string;
}

export function createEnrichmentQueue(
  redisUrl: string,
  name: string = ENRICHMENT_QUEUE,
): Queue<EnrichmentJob> {
  return new Queue<EnrichmentJob>(name, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      // 3 attempts with exponential backoff; after the final failure the
      // worker marks the moment enrichment_status 'failed' and logs it.
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}
