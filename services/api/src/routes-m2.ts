import {
  approveActionRequestSchema,
  memorySearchRequestSchema,
  type ContextMoment,
  type ListActionsResponse,
  type MemorySearchResponse,
  type MemorySearchResult,
  type ProjectDetailResponse,
} from "@nova/schema";
import type { EmbeddingProvider } from "@nova/model-router";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "./auth/plugin.js";
import type pg from "pg";
import { z } from "zod";
import { AdapterRegistry } from "./adapters/types.js";
import { NovaTaskAdapter } from "./adapters/nova-task.js";
import { NotionAdapter } from "./adapters/notion.js";
import type { Analytics } from "./analytics.js";
import type { Queue } from "bullmq";
import type { MomentMediaRef } from "@nova/schema";
import type { ActionJob } from "./queue.js";

export interface M2RouteDeps {
  db: pg.Pool;
  embedder: EmbeddingProvider | null;
  momentColumns: string;
  momentColumnsPrefixed: string;
  rowToMoment: (row: never) => ContextMoment;
  analytics: Analytics;
  /** M6: external actions enqueue here on approval; null = no Redis. */
  actionQueue: Queue<ActionJob> | null;
  /** M8: attach media refs to API-shaped moments. */
  attachMedia: <T extends { id: string }>(items: T[]) => Promise<Array<T & { media: MomentMediaRef[] }>>;
}

export function buildAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new NovaTaskAdapter());
  registry.register(new NotionAdapter());
  return registry;
}

export function registerM2Routes(app: FastifyInstance, deps: M2RouteDeps): void {
  const { db, embedder, momentColumns, momentColumnsPrefixed, analytics, actionQueue, attachMedia } = deps;
  const rowToMoment = deps.rowToMoment as (row: unknown) => ContextMoment;
  const registry = buildAdapterRegistry();

  /**
   * Hybrid memory search. Both legs share the same filters; scores are
   * min-max normalized per leg and fused (0.6 keyword, 0.4 vector). The
   * vector leg runs only when a query is present, an embedder is configured,
   * and the user has moment embeddings.
   */
  app.post("/v1/memory/search", async (req, reply) => {
    const parsed = memorySearchRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const input = parsed.data;
    const userId = requireAuth(req).userId;

    const conditions: string[] = ["m.user_id = $1"];
    const params: unknown[] = [userId];
    const addParam = (value: unknown): number => {
      params.push(value);
      return params.length;
    };
    if (input.project_id) conditions.push(`m.project_id = $${addParam(input.project_id)}`);
    if (input.domain) {
      conditions.push(`m.source_meta->>'url' ILIKE $${addParam(`%://%${input.domain}%`)}`);
    }
    if (input.action_type) {
      conditions.push(`m.intent_parsed->>'action_type' = $${addParam(input.action_type)}`);
    }
    if (input.priority) {
      conditions.push(`m.intent_parsed->>'priority_guess' = $${addParam(input.priority)}`);
    }
    if (input.enrichment_status) {
      conditions.push(`m.enrichment_status = $${addParam(input.enrichment_status)}`);
    }
    // M8: media filters.
    if (input.has_media === true) {
      conditions.push(`EXISTS (SELECT 1 FROM moment_media mm WHERE mm.moment_id = m.id)`);
    } else if (input.has_media === false) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM moment_media mm WHERE mm.moment_id = m.id)`);
    }
    if (input.image_redaction_state) {
      conditions.push(`m.image_redaction->>'state' = $${addParam(input.image_redaction_state)}`);
    }
    const where = conditions.join(" AND ");
    const query = input.query?.trim() || null;

    interface Scored {
      row: Record<string, unknown>;
      fts: number | null;
      vector: number | null;
      prefixFallback: boolean;
    }
    const byId = new Map<string, Scored>();

    let ftsRan = false;
    let prefixFallbackRan = false;
    if (query) {
      ftsRan = true;
      const qParam = addParam(query);
      const { rows } = await db.query(
        `SELECT ${momentColumnsPrefixed},
                ts_rank(m.tsv, websearch_to_tsquery('english', $${qParam})) AS rank
         FROM context_moments m
         WHERE ${where} AND m.tsv @@ websearch_to_tsquery('english', $${qParam})
         ORDER BY rank DESC
         LIMIT 50`,
        params,
      );
      for (const row of rows) {
        byId.set(row.id as string, {
          row,
          fts: Number(row.rank),
          vector: null,
          prefixFallback: false,
        });
      }
      params.pop();

      // M9 fuzzy/partial fallback: whole-word FTS found nothing, so retry
      // the same tsvector with prefix-matching lexemes ("kuber" → kuber:*).
      // Documented limitation: this is prefix matching, not typo tolerance.
      if (!rows.length) {
        const prefixQuery = buildPrefixTsQuery(query);
        if (prefixQuery) {
          const pParam = addParam(prefixQuery);
          const { rows: prefixRows } = await db.query(
            `SELECT ${momentColumnsPrefixed},
                    ts_rank(m.tsv, to_tsquery('english', $${pParam})) AS rank
             FROM context_moments m
             WHERE ${where} AND m.tsv @@ to_tsquery('english', $${pParam})
             ORDER BY rank DESC
             LIMIT 50`,
            params,
          );
          prefixFallbackRan = prefixRows.length > 0;
          for (const row of prefixRows) {
            byId.set(row.id as string, {
              row,
              fts: Number(row.rank),
              vector: null,
              prefixFallback: true,
            });
          }
          params.pop();
        }
      }
    }

    let vectorRan = false;
    if (query && embedder) {
      try {
        const queryVector = await embedder.embed(query);
        vectorRan = true;
        const vParam = addParam(`[${queryVector.join(",")}]`);
        const { rows } = await db.query(
          `SELECT ${momentColumnsPrefixed},
                  1 - (e.embedding <=> $${vParam}::vector) AS similarity
           FROM embeddings e
           JOIN context_moments m ON m.id = e.owner_id
           WHERE e.owner_kind = 'moment' AND e.user_id = $1 AND ${where}
           ORDER BY e.embedding <=> $${vParam}::vector ASC
           LIMIT 50`,
          params,
        );
        for (const row of rows) {
          const existing = byId.get(row.id as string);
          if (existing) existing.vector = Number(row.similarity);
          else
            byId.set(row.id as string, {
              row,
              fts: null,
              vector: Number(row.similarity),
              prefixFallback: false,
            });
        }
        params.pop();
      } catch (err) {
        // Vector search is additive; keyword results still return.
        req.log.warn({ err }, "vector search leg failed");
      }
    }

    let items: Array<MemorySearchResult & { media?: MomentMediaRef[] }>;
    if (query) {
      const scored = [...byId.values()];
      const maxFts = Math.max(...scored.map((s) => s.fts ?? 0), 1e-9);
      const maxVec = Math.max(...scored.map((s) => s.vector ?? 0), 1e-9);
      items = scored
        .map((s) => {
          const ftsNorm = s.fts != null ? s.fts / maxFts : 0;
          const vecNorm = s.vector != null ? s.vector / maxVec : 0;
          const match =
            s.fts != null && s.vector != null ? "both" : s.fts != null ? "fts" : "vector";
          return {
            ...rowToMoment(s.row),
            score: Number((0.6 * ftsNorm + 0.4 * vecNorm).toFixed(4)),
            match: match as MemorySearchResult["match"],
            // M9 ranking diagnostics: raw leg scores on request.
            ...(input.debug
              ? {
                  diagnostics: {
                    fts_rank: s.fts,
                    vector_similarity: s.vector,
                    prefix_fallback: s.prefixFallback,
                  },
                }
              : {}),
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit);
    } else {
      // Filter-only listing, newest first.
      const limitParam = addParam(input.limit);
      const { rows } = await db.query(
        `SELECT ${momentColumnsPrefixed}
         FROM context_moments m
         WHERE ${where}
         ORDER BY m.captured_at DESC
         LIMIT $${limitParam}`,
        params,
      );
      items = rows.map((row) => ({
        ...rowToMoment(row),
        score: 0,
        match: "filter" as const,
      }));
    }

    items = await attachMedia(items);
    analytics.track(userId, "search_performed", {
      has_query: Boolean(query),
      results: items.length,
      fts: ftsRan,
      vector: vectorRan,
    });
    const response: MemorySearchResponse = {
      items,
      legs: { fts: ftsRan, vector: vectorRan, prefix_fallback: prefixFallbackRan },
    };
    return response;
  });

  app.get("/v1/actions", async (req, reply) => {
    const query = z
      .object({
        status: z
          .enum(["proposed", "approved", "executing", "done", "failed", "rejected"])
          .optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const userId = requireAuth(req).userId;
    const conditions = ["a.user_id = $1"];
    const params: unknown[] = [userId];
    if (query.data.status) {
      params.push(query.data.status);
      conditions.push(`a.status = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT a.id, a.moment_id, a.project_id, a.action_type, a.risk_tier,
              a.status, a.payload, a.result, a.created_at, a.updated_at,
              m.source_meta->>'title' AS moment_title,
              p.name AS project_name
       FROM actions a
       LEFT JOIN context_moments m ON m.id = a.moment_id
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY a.created_at DESC
       LIMIT 200`,
      params,
    );
    const response: ListActionsResponse = {
      items: rows.map((r) => ({
        ...r,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      })),
    };
    return response;
  });

  /**
   * Approve. Only 'proposed' actions can be approved. Internal adapters
   * (nova_task) still execute inline — fast, reversible, no provider call.
   * External adapters (M6) are QUEUED for services/worker instead: the
   * claim is atomic (double approval loses), the job id equals the action
   * id (duplicate enqueue collapses), and every transition is audited.
   */
  app.post("/v1/actions/:id/approve", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const userId = requireAuth(req).userId;

    const existing = await db.query(
      "SELECT id, action_type, status FROM actions WHERE id = $1 AND user_id = $2",
      [params.data.id, userId],
    );
    if (!existing.rows.length) return reply.code(404).send({ error: "not_found" });
    const adapterForType = registry.get(existing.rows[0].action_type);

    if (adapterForType?.external) {
      // M7: optional approval-time destination override (validated shape,
      // stored on the action so preview == execution destination).
      const approveBody = approveActionRequestSchema.safeParse(req.body ?? {});
      if (!approveBody.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      // Fail BEFORE any state change: no connection or no queue means the
      // action stays 'proposed' and the UI can explain what's missing.
      if (adapterForType.provider) {
        const conn = await db.query(
          `SELECT 1 FROM integration_connections
           WHERE user_id = $1 AND provider = $2 AND status = 'active'`,
          [userId, adapterForType.provider],
        );
        if (!conn.rows.length) {
          return reply.code(409).send({
            error: `${adapterForType.provider}_not_connected`,
            message: `Connect ${adapterForType.provider} in Settings before approving this action.`,
          });
        }
      }
      if (!actionQueue) {
        return reply.code(503).send({
          error: "action_queue_unavailable",
          message: "External actions need the execution queue (set REDIS_URL on the API).",
        });
      }

      const claim = await db.query(
        `UPDATE actions
         SET status = 'queued', approved_by = $1, approved_at = now(), updated_at = now(),
             payload = CASE WHEN $3::jsonb IS NULL THEN payload
                            ELSE jsonb_set(payload, '{destination}', $3::jsonb) END
         WHERE id = $2 AND user_id = $1 AND status = 'proposed'
         RETURNING id, action_type`,
        [
          userId,
          params.data.id,
          approveBody.data.destination ? JSON.stringify(approveBody.data.destination) : null,
        ],
      );
      const queuedAction = claim.rows[0];
      if (!queuedAction) {
        const now = await db.query(
          "SELECT status FROM actions WHERE id = $1 AND user_id = $2",
          [params.data.id, userId],
        );
        return reply.code(409).send({
          error: "invalid_state",
          status: now.rows[0]?.status,
          message: "Only proposed actions can be approved.",
        });
      }
      await db.query(
        `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
         VALUES ($1, 'action.approve', 'action', $2, $3),
                ($1, 'action.queued', 'action', $2, $3)`,
        [
          userId,
          queuedAction.id,
          JSON.stringify({
            action_type: queuedAction.action_type,
            destination_override: approveBody.data.destination?.title ?? null,
          }),
        ],
      );
      try {
        await actionQueue.add(
          "execute",
          { actionId: queuedAction.id, userId } satisfies ActionJob,
          { jobId: queuedAction.id },
        );
      } catch (err) {
        // Enqueue failed: revert so the approval can be retried cleanly.
        req.log.error({ err }, "action enqueue failed; reverting to proposed");
        await db.query(
          `UPDATE actions SET status = 'proposed', approved_by = NULL, approved_at = NULL,
             updated_at = now() WHERE id = $1`,
          [queuedAction.id],
        );
        return reply.code(503).send({ error: "action_queue_unavailable" });
      }
      analytics.track(userId, "action_approved", {
        action_type: queuedAction.action_type,
        outcome: "queued",
      });
      return { id: queuedAction.id, status: "queued" };
    }

    // Claim atomically: proposed → executing (prevents double-approval).
    const claim = await db.query(
      `UPDATE actions
       SET status = 'executing', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 AND user_id = $1 AND status = 'proposed'
       RETURNING id, action_type, risk_tier, moment_id, project_id, payload`,
      [userId, params.data.id],
    );
    const action = claim.rows[0];
    if (!action) {
      const exists = await db.query(
        "SELECT status FROM actions WHERE id = $1 AND user_id = $2",
        [params.data.id, userId],
      );
      if (!exists.rows.length) return reply.code(404).send({ error: "not_found" });
      return reply.code(409).send({
        error: "invalid_state",
        status: exists.rows[0].status,
        message: "Only proposed actions can be approved.",
      });
    }

    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
       VALUES ($1, 'action.approve', 'action', $2, $3)`,
      [userId, action.id, JSON.stringify({ action_type: action.action_type })],
    );

    const adapter = registry.get(action.action_type);
    let ok = false;
    let result: Record<string, unknown>;
    if (!adapter) {
      result = { error: "unknown_action_type" };
    } else {
      try {
        const executed = await adapter.execute({ db, userId }, action);
        ok = executed.ok;
        result = executed.result;
      } catch (err) {
        result = { error: "execution_error", message: (err as Error).message };
      }
    }
    const finalStatus = ok ? "done" : "failed";
    await db.query(
      `UPDATE actions SET status = $1, result = $2, updated_at = now() WHERE id = $3`,
      [finalStatus, JSON.stringify(result), action.id],
    );
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
       VALUES ($1, $2, 'action', $3, $4)`,
      [
        userId,
        ok ? "action.execute" : "action.execute.failed",
        action.id,
        JSON.stringify({ action_type: action.action_type, ...(ok ? {} : { result }) }),
      ],
    );
    analytics.track(userId, "action_approved", {
      action_type: action.action_type,
      outcome: finalStatus,
    });
    return { id: action.id, status: finalStatus, result };
  });

  app.post("/v1/actions/:id/reject", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const userId = requireAuth(req).userId;
    const { rows } = await db.query(
      `UPDATE actions SET status = 'rejected', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'proposed'
       RETURNING id, action_type`,
      [params.data.id, userId],
    );
    const action = rows[0];
    if (!action) {
      const exists = await db.query(
        "SELECT status FROM actions WHERE id = $1 AND user_id = $2",
        [params.data.id, userId],
      );
      if (!exists.rows.length) return reply.code(404).send({ error: "not_found" });
      return reply.code(409).send({ error: "invalid_state", status: exists.rows[0].status });
    }
    await db.query(
      `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
       VALUES ($1, 'action.reject', 'action', $2, $3)`,
      [userId, action.id, JSON.stringify({ action_type: action.action_type })],
    );
    analytics.track(userId, "action_rejected", { action_type: action.action_type });
    return { id: action.id, status: "rejected" };
  });

  app.get("/v1/projects/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const userId = requireAuth(req).userId;

    const projectRes = await db.query(
      `SELECT id, name, description, created_at FROM projects
       WHERE id = $1 AND user_id = $2 AND archived = false`,
      [params.data.id, userId],
    );
    const project = projectRes.rows[0];
    if (!project) return reply.code(404).send({ error: "not_found" });

    const [moments, tasks, actions, domains, activity] = await Promise.all([
      db.query(
        `SELECT ${momentColumns} FROM context_moments
         WHERE project_id = $1 AND user_id = $2
         ORDER BY captured_at DESC LIMIT 50`,
        [project.id, userId],
      ),
      db.query(
        `SELECT id, project_id, moment_id, title, notes, priority, status, created_at, completed_at
         FROM tasks WHERE project_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 50`,
        [project.id, userId],
      ),
      db.query(
        `SELECT id, moment_id, project_id, action_type, risk_tier, status, payload, result, created_at, updated_at
         FROM actions WHERE project_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 50`,
        [project.id, userId],
      ),
      db.query(
        `SELECT split_part(split_part(source_meta->>'url', '://', 2), '/', 1) AS domain,
                count(*) AS count
         FROM context_moments
         WHERE project_id = $1 AND user_id = $2 AND source_meta->>'url' IS NOT NULL
         GROUP BY 1 ORDER BY count DESC LIMIT 10`,
        [project.id, userId],
      ),
      db.query(
        `(SELECT 'moment' AS kind, id, coalesce(source_meta->>'title', 'Captured page') AS label, captured_at AS at
          FROM context_moments WHERE project_id = $1 AND user_id = $2)
         UNION ALL
         (SELECT 'task' AS kind, id, title AS label, created_at AS at
          FROM tasks WHERE project_id = $1 AND user_id = $2)
         UNION ALL
         (SELECT 'action' AS kind, id, action_type || ' → ' || status AS label, updated_at AS at
          FROM actions WHERE project_id = $1 AND user_id = $2)
         ORDER BY at DESC LIMIT 20`,
        [project.id, userId],
      ),
    ]);

    const response: ProjectDetailResponse = {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        created_at: project.created_at.toISOString(),
      },
      moments: await attachMedia(moments.rows.map((row) => rowToMoment(row))),
      tasks: tasks.rows.map((t) => ({
        ...t,
        created_at: t.created_at.toISOString(),
        completed_at: t.completed_at ? t.completed_at.toISOString() : null,
      })),
      actions: actions.rows.map((a) => ({
        ...a,
        created_at: a.created_at.toISOString(),
        updated_at: a.updated_at.toISOString(),
      })),
      domains: domains.rows.map((d) => ({ domain: d.domain, count: Number(d.count) })),
      activity: activity.rows.map((e) => ({
        kind: e.kind,
        id: e.id,
        label: e.label,
        at: e.at.toISOString(),
      })),
    };
    return response;
  });
}

/**
 * M9: turn free text into a prefix-matching tsquery ("kuber deplo" →
 * "kuber:* & deplo:*"). Tokens are stripped to word characters so user
 * input can never inject tsquery syntax; empty result = no fallback.
 */
export function buildPrefixTsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}:*`).join(" & ");
}
