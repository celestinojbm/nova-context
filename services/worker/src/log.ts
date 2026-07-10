import { pino } from "pino";

/**
 * M11 worker observability: one structured logger for the whole worker.
 * Log lines carry job/action/moment IDS — never captured content, tokens,
 * or decrypted media (same contract as the API's logs).
 */
export const log = pino({ name: "nova-worker" });
