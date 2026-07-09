import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "./auth/plugin.js";
import type { MediaService } from "./media/media-service.js";

export interface MediaRouteDeps {
  media: MediaService | null;
}

/**
 * Media access (M8). Authenticated, strictly user-scoped, PROXIED download
 * — blobs live encrypted in object storage and are decrypted per request
 * here; no public or signed URLs exist, so nothing can outlive a session
 * or leak across users. Unknown ids and other users' media are the same
 * 404. Plain views are not audited (same policy as reading a moment);
 * export and delete are audited on their own routes.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
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
    return reply
      .header("content-type", result.contentType)
      .header("cache-control", "private, max-age=300")
      .send(result.data);
  });
}
