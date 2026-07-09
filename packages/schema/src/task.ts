import { z } from "zod";

/**
 * Nova task (M1): the first internal Tier-0 action target. Tasks live in
 * Nova's own task list and are always linked to the Context Moment that
 * produced them. External tools (Notion, GitHub) arrive in M2 as Tier-1.
 */

export const taskStatusSchema = z.enum(["open", "done"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  moment_id: z.string().uuid().nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  priority: z.enum(["low", "normal", "high"]),
  status: taskStatusSchema,
  created_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(
    taskSchema.extend({
      project_name: z.string().nullable(),
      moment_title: z.string().nullable(),
    }),
  ),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const updateTaskRequestSchema = z
  .object({
    status: taskStatusSchema,
  })
  .strict();
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
