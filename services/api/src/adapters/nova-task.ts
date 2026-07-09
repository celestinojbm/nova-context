import { z } from "zod";
import type {
  ActionAdapter,
  ActionInput,
  AdapterContext,
  AdapterResult,
} from "./types.js";

const payloadSchema = z.object({
  title: z.string().min(1).max(512),
  detail: z.string().max(2000).nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

/** Tier-0 internal adapter: create a task in Nova's own list. */
export class NovaTaskAdapter implements ActionAdapter {
  readonly actionType = "nova_task";
  readonly riskTier = 0 as const;
  readonly external = false;

  preview(action: ActionInput) {
    const parsed = payloadSchema.safeParse(action.payload);
    return {
      title: parsed.success ? parsed.data.title : "Create a Nova task",
      description: parsed.success
        ? `Creates a ${parsed.data.priority}-priority task in Nova's task list.`
        : "Invalid payload",
    };
  }

  async execute(ctx: AdapterContext, action: ActionInput): Promise<AdapterResult> {
    const payload = payloadSchema.parse(action.payload);
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO tasks (user_id, project_id, moment_id, action_id, title, notes, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        ctx.userId,
        action.project_id,
        action.moment_id,
        action.id,
        payload.title,
        payload.detail ?? null,
        payload.priority,
      ],
    );
    return { ok: true, result: { task_id: rows[0]!.id } };
  }
}
