import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { requireAuth } from "./auth/plugin.js";
import type { MediaService } from "./media/media-service.js";

export interface MediaRouteDeps {
  db: pg.Pool;
  media: MediaService | null;
  /** M9: audit direct media views (off by default — see docs/AUTH.md). */
  viewAudit: boolean;
}

/**
 * Media access (M8). Authenticated, strictly user-scoped, PROXIED download
 * — blobs live encrypted in object storage and are decrypted per request
 * here; no public or signed URLs exist, so nothing can outlive a session
 * or leak across users. Unknown ids and other users' media are the same
 * 404.
 *
 * Audit policy (M9, documented in docs/AUTH.md §Media pipeline): exports,
 * deletes, and adapter access are ALWAYS audited on their own routes.
 * Plain views follow the same policy as reading a moment — not audited by
 * default (a timeline render would write a row per thumbnail), but
 * NOVA_MEDIA_VIEW_AUDIT=on turns on per-view audit (media id + variant
 * only, never content) for deployments that want it.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  /** M9: per-user storage accounting. Aggregates only — counts and byte
   * totals per kind / redaction state / project; never keys or content.
   * (Registered before :id so "usage" never parses as a media id.) */
  app.get("/v1/media/usage", async (req, reply) => {
    const userId = requireAuth(req).userId;
    if (!deps.media) {
      return reply.code(503).send({
        error: "media_unavailable",
        message: "Media pipeline needs NOVA_ENCRYPTION_KEY on the API.",
      });
    }
    return deps.media.usageForUser(userId);
  });

  app.get("/v1/media/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({ variant: z.enum(["full", "thumb"]).default("full") })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!deps.media) {
      return reply.code(503).send({
        error: "media_unavailable",
        message: "Media pipeline needs NOVA_ENCRYPTION_KEY on the API.",
      });
    }
    const userId = requireAuth(req).userId;
    const result = await deps.media.getMedia(userId, params.data.id, query.data.variant);
    if (!result) return reply.code(404).send({ error: "not_found" });
    if (deps.viewAudit) {
      await deps.db.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'media.view', 'media', $2, $3)`,
        [userId, params.data.id, JSON.stringify({ variant: query.data.variant })],
      );
    }
    return reply
      .header("content-type", result.contentType)
      .header("cache-control", "private, max-age=300")
      .send(result.data);
  });
}
