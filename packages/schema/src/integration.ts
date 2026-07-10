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

/** M7: a Notion page or database the user shared with the integration. */
export const notionDestinationSchema = z
  .object({
    id: z.string().min(8).max(64),
    type: z.enum(["page_id", "database_id"]),
    title: z.string().min(1).max(300),
  })
  .strict();
export type NotionDestination = z.infer<typeof notionDestinationSchema>;

export interface ListDestinationsResponse {
  items: NotionDestination[];
  /** The user's saved default, if any. */
  default: NotionDestination | null;
  /** M9: the saved property mapping when the default is a database. */
  property_mapping?: NotionPropertyMapping | null;
}

/**
 * M9: mapping from Nova fields onto a Notion DATABASE destination's
 * properties. Values are the user's property NAMES in that database; null/
 * absent = don't write that field. Only `title` is required — a Notion
 * database always has exactly one title property.
 */
export const notionPropertyMappingSchema = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(200).nullable().optional(),
    source_url: z.string().min(1).max(200).nullable().optional(),
    tags: z.string().min(1).max(200).nullable().optional(),
    priority: z.string().min(1).max(200).nullable().optional(),
    created: z.string().min(1).max(200).nullable().optional(),
    moment_ref: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();
export type NotionPropertyMapping = z.infer<typeof notionPropertyMappingSchema>;

/** Nova field → Notion property type(s) that can carry it. */
export const NOTION_MAPPING_COMPATIBILITY: Record<
  keyof NotionPropertyMapping,
  string[]
> = {
  title: ["title"],
  summary: ["rich_text"],
  source_url: ["url", "rich_text"],
  tags: ["multi_select"],
  priority: ["select", "rich_text"],
  created: ["date"],
  moment_ref: ["rich_text", "url"],
};

/** M9: a property of a shared Notion database (name + type, display only). */
export interface NotionDatabaseProperty {
  name: string;
  type: string;
}

export interface ListDatabasePropertiesResponse {
  destination_id: string;
  properties: NotionDatabaseProperty[];
}

export const setDestinationRequestSchema = z
  .object({
    destination: notionDestinationSchema.nullable(),
    /** M9: only meaningful when destination.type === 'database_id'. */
    property_mapping: notionPropertyMappingSchema.nullable().optional(),
  })
  .strict();
export type SetDestinationRequest = z.infer<typeof setDestinationRequestSchema>;

/** M7: optional approval-time destination override for external actions.
 * M10: optional EXPLICIT media consent — ids of the moment's media the user
 * ticks on the approval card. Absent/empty = no media leaves Nova. */
export const approveActionRequestSchema = z
  .object({
    destination: notionDestinationSchema.optional(),
    media_ids: z.array(z.string().uuid()).max(10).optional(),
  })
  .strict();
export type ApproveActionRequest = z.infer<typeof approveActionRequestSchema>;

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
    /** M7: where the page will land (user default or first shared page). */
    destination: NotionDestination | null;
    /** M9: property mapping applied when the destination is a database. */
    property_mapping: NotionPropertyMapping | null;
  };
  /** M9/M10: media consent surface. Nothing is included by default; the
   * user ticks eligible items on the card, and only redacted
   * (redaction_state 'applied') media is ever eligible. */
  media: {
    included: boolean;
    count: number;
    /** Every media object on the linked moment, with eligibility. */
    items: Array<{
      id: string;
      kind: string;
      redaction_state: string;
      width: number | null;
      height: number | null;
      eligible: boolean;
    }>;
    /** Ids already approved for inclusion (post-approval previews). */
    approved_ids: string[];
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
