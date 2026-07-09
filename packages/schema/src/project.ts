import { z } from "zod";
import { contextMomentSchema } from "./context-moment.js";
import { actionRecordSchema } from "./action.js";
import { taskSchema } from "./task.js";

/** Project detail (M2): everything the project page needs in one response. */

export const projectDetailResponseSchema = z.object({
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: z.string().datetime({ offset: true }),
  }),
  moments: z.array(contextMomentSchema),
  tasks: z.array(taskSchema),
  actions: z.array(actionRecordSchema),
  domains: z.array(z.object({ domain: z.string(), count: z.number() })),
  activity: z.array(
    z.object({
      kind: z.enum(["moment", "task", "action"]),
      id: z.string().uuid(),
      label: z.string(),
      at: z.string().datetime({ offset: true }),
    }),
  ),
});
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;

export const listProjectsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      description: z.string().nullable(),
      created_at: z.string().datetime({ offset: true }),
      moment_count: z.number(),
      task_count: z.number(),
    }),
  ),
});
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;
