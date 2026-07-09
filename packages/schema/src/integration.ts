import { z } from "zod";

/**
 * M6 integration contracts: per-user Notion OAuth connection state and the
 * pre-approval preview for external actions. Tokens never appear in any of
 * these shapes — they exist only encrypted at rest.
 */

export interface IntegrationConnectionSummary {
  provider: string; // 'notion'
  status: "active" | "revoked" | "error";
  external_account: string | null; // workspace name — display only
  connected_at: string;
  updated_at: string;
}

export interface ListIntegrationsResponse {
  items: IntegrationConnectionSummary[];
}

export interface OAuthStartResponse {
  authorize_url: string;
}

export const oauthCallbackRequestSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(16).max(512),
  })
  .strict();
export type OAuthCallbackRequest = z.infer<typeof oauthCallbackRequestSchema>;

/** What the approval card shows for a notion_page action — assembled from
 * the same builder the worker executes, so preview == outcome. */
export interface ActionPreviewResponse {
  action_id: string;
  action_type: string;
  status: string;
  risk_tier: number;
  connection: {
    connected: boolean;
    provider: string;
    workspace: string | null;
  };
  title: string;
  summary: string | null;
  source_url: string | null;
  source_host: string | null;
  instruction: string | null;
  tags: string[];
  moment: { id: string; title: string | null; captured_at: string } | null;
  /** The exact sections that will be written to the external provider. */
  sections: Array<{ heading: string | null; text: string }>;
}
