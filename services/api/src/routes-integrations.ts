import { randomBytes } from "node:crypto";
import { buildNotionPageContent } from "@nova/context-engine";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "@nova/context-engine/secret-box";
import {
  oauthCallbackRequestSchema,
  setDestinationRequestSchema,
  type ActionPreviewResponse,
  type ListDestinationsResponse,
  type ListIntegrationsResponse,
  type NotionDestination,
  type OAuthStartResponse,
} from "@nova/schema";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { requireAuth } from "./auth/plugin.js";
import { sha256Hex } from "./auth/sessions.js";
import type { Env } from "./env.js";
import type { NotionApiClient } from "./integrations/notion-api.js";
import { NotionOAuthError, type NotionOAuthClient } from "./integrations/notion-oauth.js";

export interface IntegrationRouteDeps {
  db: pg.Pool;
  env: Env;
  /** Test override; null = Notion OAuth not configured. */
  notionOauth: NotionOAuthClient | null;
  /** M7: read-only Notion client for the destination selector. */
  notionApi: NotionApiClient | null;
}

const STATE_TTL_MINUTES = 10;

/**
 * M6 integration routes. Per-user Notion OAuth: the web app starts the flow
 * and relays the provider callback here; this service owns state validation,
 * the code exchange, and encrypted token storage. Connections are strictly
 * user-scoped — every query carries the authenticated user_id.
 */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: IntegrationRouteDeps,
): void {
  const { db, env, notionOauth, notionApi } = deps;
  const encryptionKey = env.NOVA_ENCRYPTION_KEY
    ? parseEncryptionKey(env.NOVA_ENCRYPTION_KEY)
    : null;
  const notionReady = Boolean(notionOauth && encryptionKey);

  async function audit(
    userId: string,
    eventType: string,
    detail: Record<string, unknown> = {},
  ) {
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, detail) VALUES ($1, $2, $3)`,
      [userId, eventType, JSON.stringify(detail)],
    );
  }

  app.get("/v1/integrations", async (req) => {
    const userId = requireAuth(req).userId;
    const { rows } = await db.query(
      `SELECT provider, status, external_account, created_at, updated_at
       FROM integration_connections WHERE user_id = $1 ORDER BY provider`,
      [userId],
    );
    const response: ListIntegrationsResponse = {
      items: rows.map((r) => ({
        provider: r.provider,
        status: r.status,
        external_account: r.external_account,
        connected_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      })),
    };
    return response;
  });

  /** Step 1: mint a single-use state and hand back Notion's authorize URL.
   * Web sessions only — an extension token must not start OAuth flows. */
  app.post("/v1/integrations/notion/oauth/start", async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.kind !== "web") {
      return reply.code(403).send({ error: "web_session_required" });
    }
    if (!notionReady || !notionOauth) {
      return reply.code(503).send({
        error: "notion_not_configured",
        message:
          "Set NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, NOTION_REDIRECT_URI and NOVA_ENCRYPTION_KEY on the API.",
      });
    }
    const state = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO oauth_states (user_id, provider, state_hash, expires_at)
       VALUES ($1, 'notion', $2, now() + interval '${STATE_TTL_MINUTES} minutes')`,
      [auth.userId, sha256Hex(state)],
    );
    await audit(auth.userId, "notion.connect.start", {});
    const response: OAuthStartResponse = {
      authorize_url: notionOauth.authorizeUrl(state),
    };
    return reply.code(201).send(response);
  });

  /** Step 2: the web app relays Notion's redirect (code + state) here. */
  app.post("/v1/integrations/notion/oauth/callback", async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.kind !== "web") {
      return reply.code(403).send({ error: "web_session_required" });
    }
    if (!notionReady || !notionOauth || !encryptionKey) {
      return reply.code(503).send({ error: "notion_not_configured" });
    }
    const parsed = oauthCallbackRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    // Single-use claim, bound to THIS user: a state minted by (or leaked to)
    // anyone else, expired, or replayed does not pass.
    const claim = await db.query(
      `UPDATE oauth_states SET used_at = now()
       WHERE state_hash = $1 AND user_id = $2 AND provider = 'notion'
         AND used_at IS NULL AND expires_at > now()
       RETURNING id`,
      [sha256Hex(parsed.data.state), auth.userId],
    );
    if (!claim.rowCount) {
      await audit(auth.userId, "notion.connect.failed", { reason: "invalid_state" });
      return reply.code(400).send({ error: "invalid_state" });
    }

    let result;
    try {
      result = await notionOauth.exchangeCode(parsed.data.code);
    } catch (err) {
      req.log.warn({ err }, "notion code exchange failed");
      await audit(auth.userId, "notion.connect.failed", {
        reason: err instanceof NotionOAuthError ? err.message : "exchange_error",
      });
      return reply.code(502).send({ error: "notion_exchange_failed" });
    }

    const ciphertext = encryptSecret(encryptionKey, result.accessToken);
    await db.query(
      `INSERT INTO integration_connections
         (user_id, provider, external_account, token_ciphertext, scopes, status, meta)
       VALUES ($1, 'notion', $2, $3, $4, 'active', $5)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         external_account = EXCLUDED.external_account,
         token_ciphertext = EXCLUDED.token_ciphertext,
         scopes = EXCLUDED.scopes,
         status = 'active',
         meta = EXCLUDED.meta,
         updated_at = now()`,
      [
        auth.userId,
        result.workspaceName,
        ciphertext,
        [],
        JSON.stringify({ workspace_id: result.workspaceId, bot_id: result.botId }),
      ],
    );
    // Workspace name only — never the token, never the code.
    await audit(auth.userId, "notion.connect.completed", {
      workspace: result.workspaceName,
    });
    return { connected: true, workspace: result.workspaceName };
  });

  /** M7: pages/databases the user shared with the integration. Notion has
   * no "list all" API — /v1/search over shared objects IS the safe selector
   * (the user controls the candidate set inside Notion). */
  app.get("/v1/integrations/notion/destinations", async (req, reply) => {
    const userId = requireAuth(req).userId;
    if (!encryptionKey || !notionApi) {
      return reply.code(503).send({ error: "notion_not_configured" });
    }
    const conn = await db.query<{ token_ciphertext: Buffer; meta: Record<string, unknown> }>(
      `SELECT token_ciphertext, meta FROM integration_connections
       WHERE user_id = $1 AND provider = 'notion' AND status = 'active'`,
      [userId],
    );
    if (!conn.rows.length) {
      return reply.code(409).send({ error: "notion_not_connected" });
    }
    let items: NotionDestination[];
    try {
      const token = decryptSecret(encryptionKey, conn.rows[0]!.token_ciphertext);
      items = await notionApi.listDestinations(token);
    } catch (err) {
      req.log.warn({ err }, "notion destination listing failed");
      return reply.code(502).send({ error: "notion_unreachable" });
    }
    const response: ListDestinationsResponse = {
      items,
      default: (conn.rows[0]!.meta?.default_destination as NotionDestination | undefined) ?? null,
    };
    return response;
  });

  /** M7: save (or clear, with null) the user's default destination. Stored
   * per user in their own connection row — never shared. */
  app.put("/v1/integrations/notion/destination", async (req, reply) => {
    const userId = requireAuth(req).userId;
    const parsed = setDestinationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { rowCount } = await db.query(
      `UPDATE integration_connections
       SET meta = CASE WHEN $2::jsonb IS NULL THEN meta - 'default_destination'
                       ELSE jsonb_set(meta, '{default_destination}', $2::jsonb) END,
           updated_at = now()
       WHERE user_id = $1 AND provider = 'notion' AND status = 'active'`,
      [userId, parsed.data.destination ? JSON.stringify(parsed.data.destination) : null],
    );
    if (!rowCount) return reply.code(409).send({ error: "notion_not_connected" });
    // Title only — a page title is user-chosen metadata, never captured content.
    await audit(userId, "notion.destination.set", {
      destination_title: parsed.data.destination?.title ?? null,
      destination_type: parsed.data.destination?.type ?? null,
      cleared: parsed.data.destination === null,
    });
    return { destination: parsed.data.destination };
  });

  app.delete("/v1/integrations/notion", async (req, reply) => {
    const userId = requireAuth(req).userId;
    // Revoke AND wipe the ciphertext: a disconnected row keeps no secret.
    const { rowCount } = await db.query(
      `UPDATE integration_connections
       SET status = 'revoked', token_ciphertext = ''::bytea, updated_at = now()
       WHERE user_id = $1 AND provider = 'notion' AND status = 'active'`,
      [userId],
    );
    if (!rowCount) return reply.code(404).send({ error: "not_found" });
    await audit(userId, "notion.disconnect", {});
    return { disconnected: true };
  });

  /**
   * Pre-approval preview (M6): the exact content the worker will write,
   * produced by the same builder — plus destination and connection state so
   * the web app can show "connect Notion first" instead of an approve
   * button when there is no active connection.
   */
  app.get("/v1/actions/:id/preview", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const userId = requireAuth(req).userId;

    const { rows } = await db.query(
      `SELECT a.id, a.action_type, a.status, a.risk_tier, a.payload, a.moment_id,
              m.source_meta, m.summary, m.extracted_text, m.intent_text,
              m.captured_at, m.enrichment, m.redaction_state, m.image_redaction
       FROM actions a
       LEFT JOIN context_moments m ON m.id = a.moment_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [params.data.id, userId],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.action_type !== "notion_page") {
      return reply.code(400).send({ error: "preview_unavailable" });
    }

    const connection = await db.query(
      `SELECT external_account, meta FROM integration_connections
       WHERE user_id = $1 AND provider = 'notion' AND status = 'active'`,
      [userId],
    );
    const savedDefault =
      (connection.rows[0]?.meta?.default_destination as NotionDestination | undefined) ?? null;
    const payloadDestination =
      ((row.payload as Record<string, unknown>).destination as NotionDestination | undefined) ??
      null;

    const payload = row.payload as { title?: string; detail?: string | null };
    const sourceUrl =
      typeof row.source_meta?.url === "string" ? (row.source_meta.url as string) : null;
    const tags: string[] = Array.isArray(row.enrichment?.tags) ? row.enrichment.tags : [];
    const content = buildNotionPageContent(
      { title: payload.title ?? "Nova Context page", detail: payload.detail ?? null },
      {
        momentId: row.moment_id,
        momentTitle:
          typeof row.source_meta?.title === "string" ? (row.source_meta.title as string) : null,
        momentSummary: row.summary,
        sourceUrl,
        capturedAt: row.captured_at ? row.captured_at.toISOString() : null,
        extractedText: row.extracted_text,
        instruction: row.intent_text,
        tags,
        actionId: row.id,
        textRedaction: row.redaction_state ?? null,
        imageRedaction: (row.image_redaction?.state as string | undefined) ?? "none",
        imageMaskedRegions: Number(row.image_redaction?.masked ?? 0),
      },
    );

    const response: ActionPreviewResponse = {
      action_id: row.id,
      action_type: row.action_type,
      status: row.status,
      risk_tier: row.risk_tier,
      connection: {
        connected: connection.rows.length > 0,
        provider: "notion",
        workspace: connection.rows[0]?.external_account ?? null,
        // Approval-time override > user default > first shared page.
        destination: payloadDestination ?? savedDefault,
      },
      title: content.title,
      summary: row.summary ?? payload.detail ?? null,
      source_url: sourceUrl,
      source_host: safeHost(sourceUrl),
      instruction: row.intent_text,
      tags,
      moment: row.moment_id
        ? {
            id: row.moment_id,
            title:
              typeof row.source_meta?.title === "string"
                ? (row.source_meta.title as string)
                : null,
            captured_at: row.captured_at.toISOString(),
          }
        : null,
      sections: content.sections,
    };
    return response;
  });
}

function safeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
