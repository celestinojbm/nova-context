import { z } from "zod";
import type {
  ActionAdapter,
  ActionInput,
  AdapterContext,
  AdapterResult,
} from "./types.js";

const payloadSchema = z.object({
  title: z.string().min(1).max(512),
  body: z.string().max(20_000).nullable().optional(),
});

/**
 * Tier-1 external adapter: create a Notion page — PREPARED, NOT CONNECTED.
 *
 * The interface, preview card, approval gating, and result/audit plumbing
 * are complete; execute() requires an active 'notion' row in
 * integration_connections, and the OAuth connect flow that would create one
 * is deliberately not built in M2 (it needs a registered Notion OAuth app:
 * client id/secret + redirect through the web app, plus token encryption at
 * rest). Until then, approving a notion_page action fails cleanly with
 * 'notion_not_connected' rather than pretending. Full connect flow: M3.
 */
export class NotionAdapter implements ActionAdapter {
  readonly actionType = "notion_page";
  readonly riskTier = 1 as const;

  preview(action: ActionInput) {
    const parsed = payloadSchema.safeParse(action.payload);
    return {
      title: parsed.success ? `Notion page: ${parsed.data.title}` : "Create a Notion page",
      description:
        "Creates a page in your connected Notion workspace. External write — requires your explicit approval.",
    };
  }

  async execute(ctx: AdapterContext, action: ActionInput): Promise<AdapterResult> {
    payloadSchema.parse(action.payload);
    const { rows } = await ctx.db.query(
      `SELECT id FROM integration_connections
       WHERE user_id = $1 AND provider = 'notion' AND status = 'active'`,
      [ctx.userId],
    );
    if (!rows.length) {
      return {
        ok: false,
        result: {
          error: "notion_not_connected",
          message: "Connect Notion in settings first (OAuth connect flow lands in M3).",
        },
      };
    }
    // Unreachable in M2: no connect flow can create an active connection yet.
    return {
      ok: false,
      result: { error: "notion_execution_not_implemented" },
    };
  }
}
