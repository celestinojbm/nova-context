import { z } from "zod";

/**
 * Action records (M2): the Action Engine's approval model, internal-first
 * (docs/ACTION_ENGINE.md). Worker-proposed candidates always start at
 * 'proposed' and require explicit human approval — regardless of tier —
 * because a model suggested them, the user didn't command them. Nothing
 * external executes automatically.
 */

export const actionStatusSchema = z.enum([
  "proposed",
  "awaiting_approval",
  "approved",
  "queued", // M6: approved external action waiting for the execution worker
  "executing",
  "done",
  "failed",
  "rejected",
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const actionRecordSchema = z.object({
  id: z.string().uuid(),
  moment_id: z.string().uuid().nullable(),
  project_id: z.string().uuid().nullable(),
  action_type: z.string(),
  risk_tier: z.number().int(),
  status: actionStatusSchema,
  payload: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type ActionRecord = z.infer<typeof actionRecordSchema>;

export const listActionsResponseSchema = z.object({
  items: z.array(
    actionRecordSchema.extend({
      moment_title: z.string().nullable(),
      project_name: z.string().nullable(),
    }),
  ),
});
export type ListActionsResponse = z.infer<typeof listActionsResponseSchema>;
