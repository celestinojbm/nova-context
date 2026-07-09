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
 * Tier-1 external adapter: create a Notion page (connected in M6).
 *
 * Approval-side metadata only. On approve, routes-m2 verifies an active
 * per-user Notion connection and enqueues an action-execution job; the
 * provider call itself happens in services/worker (see its notion client),
 * using the user's token decrypted from integration_connections. The rich
 * pre-approval preview lives at GET /v1/actions/:id/preview.
 */
export class NotionAdapter implements ActionAdapter {
  readonly actionType = "notion_page";
  readonly riskTier = 1 as const;
  readonly external = true;
  readonly provider = "notion";

  preview(action: ActionInput) {
    const parsed = payloadSchema.safeParse(action.payload);
    return {
      title: parsed.success ? `Notion page: ${parsed.data.title}` : "Create a Notion page",
      description:
        "Creates a page in your connected Notion workspace. External write — requires your explicit approval.",
    };
  }

  async execute(_ctx: AdapterContext, _action: ActionInput): Promise<AdapterResult> {
    // M6: external adapters never execute inline — the approve endpoint
    // enqueues a job and services/worker performs the provider call with
    // the user's decrypted connection. Defensive guard, not a code path.
    return {
      ok: false,
      result: { error: "external_adapter_executes_in_worker" },
    };
  }
}
