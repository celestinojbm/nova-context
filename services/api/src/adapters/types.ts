import type pg from "pg";

/**
 * Action adapter interface (M2 — docs/ACTION_ENGINE.md). Adapters accept
 * only validated, allowlisted payloads and run strictly AFTER the approval
 * gate in routes-m2: nothing calls execute() on an action that a human has
 * not explicitly approved (worker proposals) or explicitly commanded at
 * capture time (M1's Tier-0 nova_task path).
 */

export interface AdapterContext {
  db: pg.Pool;
  userId: string;
}

export interface ActionInput {
  id: string;
  action_type: string;
  risk_tier: number;
  moment_id: string | null;
  project_id: string | null;
  payload: Record<string, unknown>;
}

export interface AdapterResult {
  ok: boolean;
  // Stored in actions.result; must never contain secrets.
  result: Record<string, unknown>;
}

export interface ActionAdapter {
  readonly actionType: string;
  readonly riskTier: 0 | 1 | 2;
  /** Human-readable preview shown on the approval card. */
  preview(action: ActionInput): { title: string; description: string };
  /** Execute the approved action. Throwing marks the action 'failed'. */
  execute(ctx: AdapterContext, action: ActionInput): Promise<AdapterResult>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ActionAdapter>();

  register(adapter: ActionAdapter): void {
    this.adapters.set(adapter.actionType, adapter);
  }

  get(actionType: string): ActionAdapter | undefined {
    return this.adapters.get(actionType);
  }
}
