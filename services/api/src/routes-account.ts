import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { ContextMoment } from "@nova/schema";
import type { Analytics } from "./analytics.js";
import { requireAuth } from "./auth/plugin.js";
import { verifyPassword } from "./auth/passwords.js";
import { sha256Hex } from "./auth/sessions.js";
import type { MediaService } from "./media/media-service.js";

export interface AccountRouteDeps {
  db: pg.Pool;
  media: MediaService | null;
  analytics: Analytics;
  momentColumns: string;
  rowToMoment: (row: never) => ContextMoment;
}

/**
 * M10: account data lifecycle — the user is root authority over their data
 * (docs/FIRST_PRINCIPLES.md). Two endpoints:
 *
 *   GET  /v1/export/account          everything, one JSON document
 *   POST /v1/auth/account/delete     everything, gone
 *
 * Retention contract (documented in docs/AUTH.md §Account lifecycle):
 * deletion removes ALL captured content, media blobs, enrichment, tasks,
 * actions, sessions, integration tokens, product events, and audit rows
 * (cascade). What survives: (1) a single account_tombstones row — deleted
 * user id, sha256(email), row/object COUNTS — the security/abuse record
 * that an account existed and was deleted; (2) media_delete_queue rows for
 * blobs whose storage delete failed mid-flight, kept so `media:cleanup`
 * can still remove the (encrypted, unreadable) objects; (3) nothing else.
 */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const { db, media, analytics, momentColumns } = deps;
  const rowToMoment = deps.rowToMoment as (row: unknown) => ContextMoment;

  /** Full account export. Everything the account owns, one document;
   * media=refs (default) links via authenticated URLs, media=full inlines
   * the redacted blobs as data URLs. Never token ciphertext or plaintext. */
  app.get("/v1/export/account", async (req, reply) => {
    const query = z
      .object({ media: z.enum(["refs", "full"]).default("refs") })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const userId = requireAuth(req).userId;

    const [user, projects, moments, tasks, actions, integrations, sessions, audit, events, versions] =
      await Promise.all([
        db.query(
          `SELECT id, email, display_name, created_at FROM users WHERE id = $1`,
          [userId],
        ),
        db.query(
          `SELECT id, name, description, local_only, archived, created_at, updated_at
           FROM projects WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        db.query(
          `SELECT ${momentColumns} FROM context_moments
           WHERE user_id = $1 ORDER BY captured_at ASC`,
          [userId],
        ),
        db.query(
          `SELECT id, project_id, moment_id, title, notes, priority, status, created_at, completed_at
           FROM tasks WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        db.query(
          `SELECT id, moment_id, project_id, action_type, risk_tier, status, payload, result,
                  created_at, updated_at
           FROM actions WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        // Connection METADATA only — token_ciphertext is deliberately not
        // selected, so tokens cannot leak into an export even encrypted.
        db.query(
          `SELECT provider, status, external_account, scopes, meta, created_at, updated_at
           FROM integration_connections WHERE user_id = $1 ORDER BY provider`,
          [userId],
        ),
        db.query(
          `SELECT id, kind, label, created_at, last_used_at, expires_at
           FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC`,
          [userId],
        ),
        db.query(
          `SELECT event_type, subject_kind, subject_id, detail, created_at
           FROM audit_log WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        db.query(
          `SELECT event, props, created_at FROM product_events
           WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId],
        ),
        db.query(
          `SELECT moment_id, version, summary, enrichment, provider, model, created_at
           FROM enrichment_versions WHERE user_id = $1 ORDER BY moment_id, version ASC`,
          [userId],
        ),
      ]);

    const momentIds = moments.rows.map((r: { id: string }) => r.id);
    let mediaByMoment: Map<string, unknown[]> = new Map();
    if (media && momentIds.length) {
      mediaByMoment =
        query.data.media === "full"
          ? ((await media.exportForMoments(userId, momentIds)) as unknown as Map<string, unknown[]>)
          : ((await media.listForMoments(momentIds)) as unknown as Map<string, unknown[]>);
    }

    await db.query(
      `INSERT INTO audit_log (user_id, event_type, detail) VALUES ($1, 'export', $2)`,
      [
        userId,
        JSON.stringify({
          scope: "account",
          media_mode: query.data.media,
          moments: moments.rowCount,
        }),
      ],
    );
    analytics.track(userId, "export_requested", {
      moments: moments.rowCount ?? 0,
      filtered: false,
    });
    reply.header(
      "content-disposition",
      `attachment; filename="nova-account-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return {
      format: "nova-account-export",
      format_version: 1,
      exported_at: new Date().toISOString(),
      media_mode: query.data.media,
      user: user.rows[0] ?? null,
      projects: projects.rows,
      moments: moments.rows.map((row) => ({
        ...rowToMoment(row),
        media: mediaByMoment.get((row as { id: string }).id) ?? [],
      })),
      tasks: tasks.rows,
      actions: actions.rows,
      integrations: integrations.rows,
      sessions: sessions.rows,
      audit_log: audit.rows,
      product_events: events.rows,
      enrichment_versions: versions.rows,
    };
  });

  /** M10 enrichment versioning: list a moment's enrichment history. */
  app.get("/v1/context/moments/:id/enrichment/versions", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const userId = requireAuth(req).userId;
    const moment = await db.query(
      `SELECT enrichment, summary FROM context_moments WHERE id = $1 AND user_id = $2`,
      [params.data.id, userId],
    );
    if (!moment.rows.length) return reply.code(404).send({ error: "not_found" });
    const { rows } = await db.query(
      `SELECT version, summary, enrichment, provider, model, created_at
       FROM enrichment_versions WHERE moment_id = $1 AND user_id = $2
       ORDER BY version DESC`,
      [params.data.id, userId],
    );
    return {
      moment_id: params.data.id,
      current: { summary: moment.rows[0].summary, enrichment: moment.rows[0].enrichment },
      versions: rows,
    };
  });

  /** M10: point the moment's CURRENT enrichment at a recorded version.
   * Nothing is lost — selection only moves the pointer. */
  app.post("/v1/context/moments/:id/enrichment/select", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ version: z.number().int().min(1) }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const userId = requireAuth(req).userId;
    const version = await db.query<{ summary: string | null; enrichment: unknown }>(
      `SELECT summary, enrichment FROM enrichment_versions
       WHERE moment_id = $1 AND user_id = $2 AND version = $3`,
      [params.data.id, userId, body.data.version],
    );
    if (!version.rows.length) return reply.code(404).send({ error: "not_found" });
    const updated = await db.query(
      `UPDATE context_moments SET summary = $1, enrichment = $2
       WHERE id = $3 AND user_id = $4 RETURNING id`,
      [
        version.rows[0]!.summary,
        JSON.stringify(version.rows[0]!.enrichment),
        params.data.id,
        userId,
      ],
    );
    if (!updated.rows.length) return reply.code(404).send({ error: "not_found" });
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
       VALUES ($1, 'enrichment.version.selected', 'moment', $2, $3)`,
      [userId, params.data.id, JSON.stringify({ version: body.data.version })],
    );
    return { selected: body.data.version };
  });

  /**
   * Full account deletion. Web session + password + typed confirmation —
   * three independent proofs of intent before anything destructive runs.
   * Blob deletion happens first (failures tombstone into media_delete_queue,
   * which survives the account); then one transaction writes the tombstone
   * and deletes the user row, cascading every remaining table. After the
   * COMMIT the account's sessions no longer resolve: every future API call
   * is an ordinary 401.
   */
  app.post("/v1/auth/account/delete", async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.kind !== "web") {
      return reply.code(403).send({ error: "web_session_required" });
    }
    const parsed = z
      .object({ password: z.string().min(1), confirm: z.literal("DELETE") })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "confirmation_required",
        message: 'Send your password and confirm: "DELETE".',
      });
    }
    const { rows } = await db.query<{ email: string; password_hash: string | null }>(
      `SELECT email, password_hash FROM users WHERE id = $1`,
      [auth.userId],
    );
    const user = rows[0];
    if (!user?.password_hash || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      return reply.code(401).send({ error: "invalid_password" });
    }

    // Counts for the tombstone — gathered before anything disappears.
    const countOf = async (sql: string): Promise<number> =>
      Number((await db.query<{ n: string }>(sql, [auth.userId])).rows[0]!.n);
    const counts = {
      projects: await countOf(`SELECT count(*) AS n FROM projects WHERE user_id = $1`),
      moments: await countOf(`SELECT count(*) AS n FROM context_moments WHERE user_id = $1`),
      tasks: await countOf(`SELECT count(*) AS n FROM tasks WHERE user_id = $1`),
      actions: await countOf(`SELECT count(*) AS n FROM actions WHERE user_id = $1`),
      media_objects: await countOf(`SELECT count(*) AS n FROM moment_media WHERE user_id = $1`),
      sessions: await countOf(
        `SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      ),
      integrations: await countOf(
        `SELECT count(*) AS n FROM integration_connections WHERE user_id = $1`,
      ),
    };

    // 1. Media blobs out of object storage. A store failure NEVER blocks
    //    the deletion — the keys tombstone into media_delete_queue (no FK,
    //    survives the account) for `media:cleanup` to finish the job.
    let mediaResult = { deleted: 0, queued: 0 };
    if (media && counts.media_objects > 0) {
      const momentIds = (
        await db.query<{ moment_id: string }>(
          `SELECT DISTINCT moment_id FROM moment_media WHERE user_id = $1`,
          [auth.userId],
        )
      ).rows.map((r) => r.moment_id);
      mediaResult = await media.deleteForMoments(auth.userId, momentIds);
    }

    // 2. Belt and braces: overwrite token ciphertext before the rows go,
    //    so no window exists where a crashed deletion left live secrets.
    await db.query(
      `UPDATE integration_connections
       SET token_ciphertext = ''::bytea, status = 'revoked', updated_at = now()
       WHERE user_id = $1`,
      [auth.userId],
    );

    // 3. Tombstone + cascade delete, atomically. The tombstone carries
    //    counts and an email hash — never content, never plaintext identity.
    const client = await db.connect();
    let tombstoneId: string;
    try {
      await client.query("BEGIN");
      const tombstone = await client.query<{ id: string }>(
        `INSERT INTO account_tombstones (deleted_user_id, email_hash, detail)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          auth.userId,
          sha256Hex(user.email.toLowerCase()),
          JSON.stringify({
            ...counts,
            media_blobs_deleted: mediaResult.deleted,
            media_blobs_queued: mediaResult.queued,
          }),
        ],
      );
      tombstoneId = tombstone.rows[0]!.id;
      // Cascades: projects, moments (→ moment_media, entity_mentions,
      // memory_items, enrichment_versions), tasks, actions, entities,
      // embeddings, sessions, pairing_codes, oauth_states,
      // integration_connections, audit_log, product_events.
      await client.query(`DELETE FROM users WHERE id = $1`, [auth.userId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // No analytics after the fact — the user is gone.
    return {
      deleted: true,
      tombstone_id: tombstoneId,
      media: mediaResult,
    };
  });
}
