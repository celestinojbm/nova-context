import { z } from "zod";

/**
 * M13: private-alpha feedback intake. Category is an allowlist covering the
 * triage buckets the alpha cares about; message is USER-AUTHORED text. The
 * contract deliberately has no attachment field — screenshots and captured
 * content have no path into feedback, and pasted data URLs are rejected.
 */

export const FEEDBACK_CATEGORIES = [
  "bug",
  "privacy",
  "capture_failure",
  "search_failure",
  "live_failure",
  "notion_failure",
  "ux",
  "feature",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const feedbackRequestSchema = z
  .object({
    category: z.enum(FEEDBACK_CATEGORIES),
    message: z
      .string()
      .trim()
      .min(3, "say a little more")
      .max(4000)
      .refine((m) => !/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(m), {
        message: "feedback is text-only — do not paste screenshots or data URLs",
      }),
  })
  .strict();
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

export interface FeedbackItem {
  id: string;
  category: FeedbackCategory;
  message: string;
  status: "new" | "triaged" | "done";
  created_at: string;
}
