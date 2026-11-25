import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { redactText } from "@nova/context-engine";
import { sha256Hex } from "./auth/sessions.js";
import { ItemWriteGate, defaultItemLockConnections } from "./item-write-gate.js";
import { renderNamespaceMarkdown, type ExportItem } from "./memory/markdown.js";
import { newNamespaceToken, SCOPES, SLUG_RE, type Scope } from "./memory/tokens.js";

/**
 * M20b — memory namespaces, per-namespace tokens and Markdown export
 * (docs/design/memoria-m20.md §2, §2.4).
 *
 * Callers: a user session (full control of their own namespaces) or a
 * namespace token (`nvx_…`, only the memory/export routes, only granted
 * namespaces, only granted scopes). Anything not visible to the caller is a
 * 404 so existence never leaks. Audit rows never carry content.
 */

type Caller =
  | { kind: "user"; userId: string }
  | { kind: "token"; userId: string; tokenId: string; prefix: string; grants: Map<string, Set<Scope>> };

interface NamespaceRow {
  id: string;
  slug: string;
  kind: string;
  project_id: string | null;
  local_only: boolean;
  created_at: Date;
}

const RESERVED_SEGMENTS = new Set(["memory"]);

function caller(req: FastifyRequest): Caller {
  if (req.nsToken) {
    const t = req.nsToken;
    return { kind: "token", userId: t.userId, tokenId: t.tokenId, prefix: t.prefix, grants: t.grants };
  }
  if (req.auth) return { kind: "user", userId: req.auth.userId };
  throw Object.assign(new Error("route reached without auth context"), { statusCode: 500 });
}

function userOnly(req: FastifyRequest, reply: FastifyReply): string | null {
  const c = caller(req);
  if (c.kind !== "user") {
    void reply.code(404).send({ error: "not_found" });
    return null;
  }
  return c.userId;
}

export function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.split("/").some((s) => RESERVED_SEGMENTS.has(s));
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

/** Idempotent: 'default' + one 'project' namespace per live project; assigns orphan facts. */
export async function ensureNamespaces(db: pg.Pool, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, 'default', 'default')
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  await db.query(
    `INSERT INTO memory_namespaces (user_id, slug, kind, project_id)
     SELECT p.user_id, 'proyecto/' || left(p.id::text, 8), 'project', p.id
     FROM projects p WHERE p.user_id = $1 AND p.archived = false
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  await db.query(`${ASSIGN_ORPHAN_FACTS_SQL} AND mi.user_id = $1`, [userId]);
}

/**
 * Orphan facts (namespace_id NULL) go to their moment's project namespace, or
 * to 'default' only when the moment has NO project. A fact whose project has
 * no namespace (archived project, slug collision) stays unassigned — invisible
 * to every token — instead of leaking into 'default'. Fail closed.
 * Mirrors the backfill in migrations/0014_m20b_namespaces_tokens.sql.
 */
const ASSIGN_ORPHAN_FACTS_SQL = `UPDATE memory_items mi SET namespace_id = COALESCE(
     (SELECT n.id FROM context_moments m JOIN memory_namespaces n
        ON n.project_id = m.project_id AND n.user_id = mi.user_id
       WHERE m.id = mi.moment_id),
     (SELECT n.id FROM memory_namespaces n WHERE n.user_id = mi.user_id AND n.slug = 'default'))
   WHERE mi.namespace_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM context_moments m
        WHERE m.id = mi.moment_id AND m.project_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM memory_namespaces n
                           WHERE n.project_id = m.project_id AND n.user_id = mi.user_id))`;

async function findNamespace(db: pg.Pool, userId: string, slug: string): Promise<NamespaceRow | null> {
  const { rows } = await db.query<NamespaceRow>(
    `SELECT n.id, n.slug, n.kind, n.project_id, COALESCE(p.local_only, false) AS local_only, n.created_at
     FROM memory_namespaces n LEFT JOIN projects p ON p.id = n.project_id
     WHERE n.user_id = $1 AND n.slug = $2 AND n.archived_at IS NULL`,
    [userId, slug],
  );
  return rows[0] ?? null;
}

/** Resolve a namespace the caller can use with `scope`; null → 404. */
async function namespaceFor(
  db: pg.Pool,
  c: Caller,
  slug: string,
  scope: Scope,
): Promise<NamespaceRow | "forbidden" | null> {
  if (c.kind === "user") await ensureNamespaces(db, c.userId);
  const ns = await findNamespace(db, c.userId, slug);
  if (!ns) return null;
  if (c.kind === "token") {
    const scopes = c.grants.get(ns.id);
    if (!scopes) return null; // not granted → indistinguishable from nonexistent
    if (!scopes.has(scope)) return "forbidden";
  }
  return ns;
}

async function audit(
  db: pg.Pool,
  c: Caller,
  event: string,
  detail: Record<string, unknown>,
  subject?: { kind: string; id: string },
): Promise<void> {
  const actor = c.kind === "token" ? `token:${c.prefix}` : "user";
  await db.query(
    `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail) VALUES ($1, $2, $3, $4, $5)`,
    [c.userId, event, subject?.kind ?? null, subject?.id ?? null, JSON.stringify({ actor, ...detail })],
  );
}

const MemoryItemSql = `SELECT mi.id, mi.content, mi.status, mi.author, mi.valid_from, mi.created_at, mi.local_only,
   COALESCE((SELECT array_agg(s.moment_id::text ORDER BY s.created_at) FROM memory_item_sources s
             WHERE s.memory_item_id = mi.id), '{}') AS sources
 FROM memory_items mi WHERE mi.user_id = $1 AND mi.namespace_id = $2`;

interface ItemRow extends ExportItem {
  local_only: boolean;
}

async function loadItems(
  db: pg.Pool,
  userId: string,
  nsId: string,
  opts: { excludeLocalOnly: boolean; status?: string; q?: string },
): Promise<ItemRow[]> {
  const params: unknown[] = [userId, nsId];
  let sql = MemoryItemSql;
  if (opts.excludeLocalOnly) sql += " AND mi.local_only = false";
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND mi.status = $${params.length}`;
  }
  const q = opts.q?.trim();
  if (q) {
    // BM25-style ranking: OR-query over non-stopword tokens, ts_rank with
    // log-length normalisation (1); best config on LongMemEval (docs/design/m20-busqueda-fts.md).
    // Trigram similarity / ILIKE only as fallback for typos and substrings that FTS cannot match.
    const terms = memoryQueryTerms(q);
    // No searchable term (1-char tokens, punctuation only: "a", "?", "a b"): there is
    // nothing to rank and a 1-char ILIKE would match almost every row, so answer
    // "no results" without touching Postgres. (The old `|| "''"` fallback was a
    // tsquery syntax error → 500.)
    if (!terms.length) return [];
    params.push(terms.join(" | "));
    const tq = `to_tsquery('simple', $${params.length})`;
    params.push(q);
    const raw = `$${params.length}`;
    params.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
    const like = `$${params.length}`;
    sql = sql.replace(
      " FROM memory_items mi",
      `, ts_rank(mi.tsv, ${tq}, 1) AS fts_rank, word_similarity(${raw}, mi.content) AS trgm_sim FROM memory_items mi`,
    );
    sql += ` AND (mi.tsv @@ ${tq} OR ${raw} <% mi.content OR mi.content ILIKE ${like})`;
    sql += " ORDER BY fts_rank DESC, trgm_sim DESC, COALESCE(mi.valid_from, mi.created_at) DESC LIMIT 500";
  } else {
    sql += " ORDER BY COALESCE(mi.valid_from, mi.created_at) DESC LIMIT 500";
  }
  const { rows } = await db.query<ItemRow>(sql, params);
  return rows;
}

// EN + ES stopwords: with the 'simple' config they would otherwise dominate the OR-query.
const MEMORY_STOP = new Set(
  (
    "the a an of in on at and or to for with my i me is are was what how did do you it that this " +
    "el la los las un una de del en y o que por para con mi me es son fue qué cómo se lo al su"
  ).split(" "),
);
/** Tokens for the OR tsquery; only letters/digits, so the tsquery is always valid. */
export function memoryQueryTerms(q: string): string[] {
  const all = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);
  const kept = all.filter((w) => !MEMORY_STOP.has(w));
  return [...new Set(kept.length ? kept : all)].slice(0, 32);
}

function slugFromRest(rest: string): string {
  return decodeURIComponent(rest).replace(/\/+$/, "");
}

const createNsBody = z.object({
  slug: z.string().min(1).max(124),
  kind: z.enum(["assistant", "custom"]).default("custom"),
});
const patchNsBody = z.object({ slug: z.string().min(1).max(124) });
const memoryBody = z.object({ content: z.string().min(1).max(2000) });
const memoryPatchBody = z
  .object({
    content: z.string().min(1).max(2000).optional(),
    status: z.enum(["active", "superseded", "contested"]).optional(),
  })
  .refine((b) => b.content !== undefined || b.status !== undefined, "empty patch");
const tokenBody = z.object({
  label: z.string().min(1).max(80),
  grants: z
    .array(z.object({ namespace: z.string().min(1).max(124), scopes: z.array(z.enum(SCOPES)).min(1) }))
    .min(1)
    .max(20),
  expires_in_days: z.number().int().min(1).max(365).nullable().default(90),
  rate_limit_per_hour: z.number().int().min(1).max(100000).default(600),
});

export interface ItemLockOptions {
  enabled: boolean;
  timeoutMs: number;
  /** Max pool connections the lock path may hold at once (default: half the pool). */
  maxConnections?: number;
}

/** Check out a pool connection, giving up after `ms` (the late connection is returned to the pool). */
async function connectWithin(db: pg.Pool, ms: number): Promise<pg.PoolClient | null> {
  if (!(ms > 0)) return null;
  const pending = db.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const won = await Promise.race([pending, timedOut]);
    if (won === null) pending.then((late) => late.release(), () => {});
    return won;
  } finally {
    clearTimeout(timer);
  }
}

/** Postgres lock_not_available: raised when `lock_timeout` expires while waiting for a row lock. */
export function isLockTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "55P03";
}

export function registerNamespaceRoutes(
  app: FastifyInstance,
  deps: { db: pg.Pool; itemLock?: ItemLockOptions },
): void {
  const { db } = deps;
  const itemLock = deps.itemLock ?? { enabled: false, timeoutMs: 5000 };
  const gate = itemLock.enabled
    ? new ItemWriteGate(itemLock.maxConnections ?? defaultItemLockConnections(db.options?.max))
    : null;

  // ---- Namespaces (session only) -------------------------------------------------
  app.get("/v1/namespaces", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    await ensureNamespaces(db, userId);
    const { rows } = await db.query(
      `SELECT n.slug, n.kind, n.project_id, COALESCE(p.local_only, false) AS local_only, n.created_at,
              (SELECT count(*)::int FROM memory_items mi WHERE mi.namespace_id = n.id AND mi.status = 'active') AS active_items
       FROM memory_namespaces n LEFT JOIN projects p ON p.id = n.project_id
       WHERE n.user_id = $1 AND n.archived_at IS NULL ORDER BY n.kind, n.slug`,
      [userId],
    );
    return { items: rows };
  });

  app.post("/v1/namespaces", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    const body = createNsBody.safeParse(req.body);
    if (!body.success || !validSlug(body.data.slug) || body.data.slug === "default" || body.data.slug.startsWith("proyecto/")) {
      return reply.code(400).send({ error: "invalid_slug" });
    }
    const { rows } = await db.query(
      `INSERT INTO memory_namespaces (user_id, slug, kind) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, slug) DO UPDATE SET archived_at = NULL
         WHERE memory_namespaces.archived_at IS NOT NULL
       RETURNING id, slug, kind, created_at`,
      [userId, body.data.slug, body.data.kind],
    );
    if (!rows[0]) return reply.code(409).send({ error: "slug_taken" });
    await audit(db, { kind: "user", userId }, "namespace.create", { namespace: body.data.slug }, { kind: "namespace", id: rows[0].id });
    return reply.code(201).send({ slug: rows[0].slug, kind: rows[0].kind, created_at: rows[0].created_at });
  });

  app.patch("/v1/namespaces/*", async (req, reply) => {
    const rest = (req.params as { "*": string })["*"];
    if (/\/memory\/[0-9a-f-]{36}$/.test(rest)) return patchMemory(req, reply, rest);
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    const slug = slugFromRest(rest);
    const body = patchNsBody.safeParse(req.body);
    if (!body.success || !validSlug(body.data.slug) || body.data.slug === "default" || body.data.slug.startsWith("proyecto/")) {
      return reply.code(400).send({ error: "invalid_slug" });
    }
    const ns = await findNamespace(db, userId, slug);
    if (!ns) return reply.code(404).send({ error: "not_found" });
    if (ns.kind === "default" || ns.kind === "project") return reply.code(409).send({ error: "namespace_not_renamable" });
    try {
      await db.query(`UPDATE memory_namespaces SET slug = $2 WHERE id = $1`, [ns.id, body.data.slug]);
    } catch {
      return reply.code(409).send({ error: "slug_taken" });
    }
    await audit(db, { kind: "user", userId }, "namespace.rename", { from: slug, to: body.data.slug }, { kind: "namespace", id: ns.id });
    return { slug: body.data.slug };
  });

  app.delete("/v1/namespaces/*", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    const slug = slugFromRest((req.params as { "*": string })["*"]);
    const ns = await findNamespace(db, userId, slug);
    if (!ns) return reply.code(404).send({ error: "not_found" });
    if (ns.kind === "default" || ns.kind === "project") return reply.code(409).send({ error: "namespace_not_archivable" });
    await db.query(`UPDATE memory_namespaces SET archived_at = now() WHERE id = $1`, [ns.id]);
    // Archiving revokes every grant on it (cascade by hand: archive ≠ row delete).
    const revoked = await db.query(`DELETE FROM namespace_token_grants WHERE namespace_id = $1`, [ns.id]);
    await audit(db, { kind: "user", userId }, "namespace.archive", { namespace: slug, grants_revoked: revoked.rowCount ?? 0 }, { kind: "namespace", id: ns.id });
    return { archived: true };
  });

  // ---- Memory inside a namespace (session or token) ------------------------------
  app.get("/v1/namespaces/*", async (req, reply) => {
    const rest = (req.params as { "*": string })["*"];
    if (!rest.endsWith("/memory")) return reply.code(404).send({ error: "not_found" });
    const c = caller(req);
    const slug = slugFromRest(rest.slice(0, -"/memory".length));
    const qs = z
      .object({
        q: z.string().max(200).optional(),
        status: z.enum(["active", "merged", "superseded", "contested", "all"]).default("active"),
        format: z.enum(["json", "markdown"]).default("json"),
      })
      .safeParse(req.query);
    if (!qs.success) return reply.code(400).send({ error: "invalid_query" });
    const ns = await namespaceFor(db, c, slug, "memory:read");
    if (!ns) return reply.code(404).send({ error: "not_found" });
    if (ns === "forbidden") return reply.code(403).send({ error: "insufficient_scope", required: "memory:read" });
    // Tokens serve remote assistants: local_only facts never leave the box through them.
    const items = await loadItems(db, c.userId, ns.id, {
      excludeLocalOnly: c.kind === "token" || qs.data.format === "markdown",
      status: qs.data.status === "all" ? undefined : qs.data.status,
      q: qs.data.q,
    });
    if (c.kind === "token") await audit(db, c, "namespace_token.use", { namespace: slug, action: "memory.read", items: items.length }, { kind: "namespace_token", id: c.tokenId });
    if (qs.data.format === "markdown") {
      return reply.type("text/markdown; charset=utf-8").send(renderNamespaceMarkdown(ns.slug, items));
    }
    return {
      namespace: ns.slug,
      items: items.map(({ local_only: _l, ...i }) => i),
    };
  });

  app.post("/v1/namespaces/*", async (req, reply) => {
    const rest = (req.params as { "*": string })["*"];
    if (!rest.endsWith("/memory")) return reply.code(404).send({ error: "not_found" });
    const c = caller(req);
    const slug = slugFromRest(rest.slice(0, -"/memory".length));
    const ns = await namespaceFor(db, c, slug, "memory:write");
    if (!ns) return reply.code(404).send({ error: "not_found" });
    if (ns === "forbidden") return reply.code(403).send({ error: "insufficient_scope", required: "memory:write" });
    const body = memoryBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const content = redactText(body.data.content).text.trim();
    // A token can only ever author 'assistant' facts; a session authors 'user' facts.
    const author = c.kind === "token" ? "assistant" : "user";
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO memory_items (user_id, layer, content, status, valid_from, author, content_hash, extractor, local_only, namespace_id)
       VALUES ($1, 'semantic', $2, 'active', now(), $3, $4, NULL, $5, $6)
       RETURNING id, created_at`,
      [c.userId, content, author, contentHash(content), ns.local_only, ns.id],
    );
    await audit(db, c, c.kind === "token" ? "namespace_token.use" : "memory.create", { namespace: slug, action: "memory.write", items: 1 }, { kind: "memory_item", id: rows[0]!.id });
    return reply.code(201).send({ id: rows[0]!.id, author, status: "active", created_at: rows[0]!.created_at });
  });

  async function patchMemory(req: FastifyRequest, reply: FastifyReply, rest: string) {
    const c = caller(req);
    const m = /^(.*)\/memory\/([0-9a-f-]{36})$/.exec(rest)!;
    const slug = slugFromRest(m[1]!);
    const itemId = m[2]!;
    const ns = await namespaceFor(db, c, slug, "memory:write");
    if (!ns) return reply.code(404).send({ error: "not_found" });
    if (ns === "forbidden") return reply.code(403).send({ error: "insufficient_scope", required: "memory:write" });
    const body = memoryPatchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const content = body.data.content !== undefined ? redactText(body.data.content).text.trim() : null;

    // M20h: with the lock on, the read-check-write runs in one transaction that
    // holds the item's row lock (FOR UPDATE), so concurrent PATCHes of the same
    // item (and any other writer, e.g. consolidation) are serialized. With it off,
    // this is the historical path.
    // Review fix: waiters queue in memory (ItemWriteGate) BEFORE checking out a
    // pool connection — one per item, at most `maxConnections` in total — so a hot
    // item can no longer park the whole pool on its row lock. Gate wait, pool wait
    // and lock wait share ONE deadline; missing it → 429 + Retry-After.
    const busy = () =>
      reply
        .code(429)
        .header("retry-after", String(Math.max(1, Math.ceil(itemLock.timeoutMs / 1000))))
        .send({ error: "item_busy" });
    let leave: (() => void) | null = null;
    let client: pg.PoolClient | null = null;
    let lockTimeoutMs = 0;
    let denied = false;
    let found = true;
    try {
      if (gate) {
        const deadline = Date.now() + itemLock.timeoutMs;
        leave = await gate.enter(itemId, deadline);
        if (!leave) return busy();
        client = await connectWithin(db, deadline - Date.now());
        // lock_timeout = 0 would mean "wait forever": below 1 ms left is a miss.
        lockTimeoutMs = deadline - Date.now();
        if (!client || lockTimeoutMs < 1) return busy();
      }
      const q: pg.Pool | pg.PoolClient = client ?? db;
      try {
        if (client) {
          await client.query("BEGIN");
          await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
        }
        const { rows } = await q.query<{ author: string; local_only: boolean }>(
          `SELECT author, local_only FROM memory_items WHERE id = $1 AND user_id = $2 AND namespace_id = $3${client ? " FOR UPDATE" : ""}`,
          [itemId, c.userId, ns.id],
        );
        const item = rows[0];
        if (!item || (c.kind === "token" && item.local_only)) {
          found = false;
        } else if (c.kind === "token" && item.author !== "assistant") {
          // §2.4: memory:write NEVER edits or resolves a user-authored fact.
          denied = true;
        } else {
          await q.query(
            `UPDATE memory_items SET content = COALESCE($2, content), content_hash = COALESCE($3, content_hash),
                    status = COALESCE($4, status)
             WHERE id = $1 AND user_id = $5 ${c.kind === "token" ? "AND author = 'assistant'" : ""}`,
            [itemId, content, content ? contentHash(content) : null, body.data.status ?? null, c.userId],
          );
        }
        if (client) await client.query("COMMIT");
      } catch (err) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        if (client && isLockTimeout(err)) return busy();
        throw err;
      }
    } finally {
      client?.release();
      leave?.();
    }
    if (!found) return reply.code(404).send({ error: "not_found" });
    if (denied) {
      await audit(db, c, "namespace_token.denied", { namespace: slug, action: "memory.update", reason: "user_fact_protected" }, { kind: "memory_item", id: itemId });
      return reply.code(403).send({ error: "user_fact_protected" });
    }
    await audit(db, c, c.kind === "token" ? "namespace_token.use" : "memory.update", { namespace: slug, action: "memory.update", items: 1 }, { kind: "memory_item", id: itemId });
    return { id: itemId, updated: true };
  }

  // ---- Markdown export ----------------------------------------------------------
  app.get("/v1/export/namespace/*", async (req, reply) => {
    const rest = (req.params as { "*": string })["*"];
    if (!rest.endsWith(".md")) return reply.code(404).send({ error: "not_found" });
    const c = caller(req);
    const slug = slugFromRest(rest.slice(0, -3));
    const ns = await namespaceFor(db, c, slug, "memory:export");
    if (!ns) return reply.code(404).send({ error: "not_found" });
    if (ns === "forbidden") return reply.code(403).send({ error: "insufficient_scope", required: "memory:export" });
    // §2.4: a local_only namespace never exports to a remote (token) destination.
    if (c.kind === "token" && ns.local_only) return reply.code(403).send({ error: "local_only_namespace" });
    const items = await loadItems(db, c.userId, ns.id, { excludeLocalOnly: true });
    await audit(
      db,
      c,
      c.kind === "token" ? "namespace_token.use" : "export",
      { namespace: slug, action: "memory.export", format: "nova-memory-md/v1", items: items.length },
      { kind: "namespace", id: ns.id },
    );
    return reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${ns.slug.replace(/\//g, "_")}.md"`)
      .send(renderNamespaceMarkdown(ns.slug, items));
  });

  // ---- Namespace tokens (session only) -------------------------------------------
  /** Token row + grants in the caller's transaction: all or nothing. */
  async function issueToken(
    client: pg.PoolClient,
    userId: string,
    input: { label: string; expiresInDays: number | null; rate: number; grants: Array<{ namespace_id: string; scopes: string[] }>; rotatedFrom?: string },
  ) {
    const { token, prefix } = newNamespaceToken();
    const { rows } = await client.query<{ id: string; expires_at: Date | null }>(
      `INSERT INTO namespace_tokens (user_id, label, token_hash, token_prefix, expires_at, rate_limit_per_hour, rotated_from)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END, $6, $7)
       RETURNING id, expires_at`,
      [userId, input.label, sha256Hex(token), prefix, input.expiresInDays, input.rate, input.rotatedFrom ?? null],
    );
    for (const g of input.grants) {
      await client.query(`INSERT INTO namespace_token_grants (token_id, namespace_id, scopes) VALUES ($1, $2, $3)`, [rows[0]!.id, g.namespace_id, g.scopes]);
    }
    return { id: rows[0]!.id, token, prefix, expires_at: rows[0]!.expires_at };
  }

  async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  app.post("/v1/namespace-tokens", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    const body = tokenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await ensureNamespaces(db, userId);
    const grants: Array<{ namespace_id: string; scopes: string[]; slug: string }> = [];
    for (const g of body.data.grants) {
      const ns = await findNamespace(db, userId, g.namespace);
      if (!ns) return reply.code(404).send({ error: "namespace_not_found" });
      // Ambiguous scopes for one namespace: refuse instead of guessing (and
      // instead of a PK violation half-way through issuance).
      if (grants.some((x) => x.namespace_id === ns.id)) return reply.code(400).send({ error: "duplicate_namespace_grant" });
      grants.push({ namespace_id: ns.id, scopes: [...new Set(g.scopes)], slug: ns.slug });
    }
    const t = await inTransaction((client) =>
      issueToken(client, userId, { label: body.data.label, expiresInDays: body.data.expires_in_days, rate: body.data.rate_limit_per_hour, grants }),
    );
    await audit(db, { kind: "user", userId }, "namespace_token.issue", { token_prefix: t.prefix, grants: grants.map((g) => ({ namespace: g.slug, scopes: g.scopes })) }, { kind: "namespace_token", id: t.id });
    return reply.code(201).send({ ...t, label: body.data.label, warning: "token shown once; store it now" });
  });

  app.get("/v1/namespace-tokens", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    const { rows } = await db.query(
      `SELECT t.id, t.label, t.token_prefix, t.expires_at, t.revoked_at, t.last_used_at, t.rate_limit_per_hour, t.created_at,
              COALESCE((SELECT json_agg(json_build_object('namespace', n.slug, 'scopes', g.scopes))
                        FROM namespace_token_grants g JOIN memory_namespaces n ON n.id = g.namespace_id
                        WHERE g.token_id = t.id), '[]') AS grants
       FROM namespace_tokens t WHERE t.user_id = $1 ORDER BY t.created_at DESC`,
      [userId],
    );
    return { items: rows };
  });

  app.delete<{ Params: { id: string } }>("/v1/namespace-tokens/:id", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    const { rows } = await db.query<{ token_prefix: string }>(
      `UPDATE namespace_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND user_id = $2 RETURNING token_prefix`,
      [req.params.id, userId],
    );
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    await audit(db, { kind: "user", userId }, "namespace_token.revoke", { token_prefix: rows[0].token_prefix }, { kind: "namespace_token", id: req.params.id });
    return { revoked: true };
  });

  // Rotation = issue a new token with the same grants/limits + revoke the old one.
  app.post<{ Params: { id: string } }>("/v1/namespace-tokens/:id/rotate", async (req, reply) => {
    const userId = userOnly(req, reply);
    if (!userId) return reply;
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    // One transaction with the old row locked: two concurrent rotations can
    // never both mint a successor, and a failure leaves the old token intact.
    const rotated = await inTransaction(async (client) => {
      const old = await client.query<{ label: string; rate_limit_per_hour: number; token_prefix: string; days: number | null }>(
        `SELECT label, rate_limit_per_hour, token_prefix,
                CASE WHEN expires_at IS NULL THEN NULL ELSE GREATEST(1, ceil(extract(epoch FROM expires_at - created_at) / 86400))::int END AS days
         FROM namespace_tokens WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         FOR UPDATE`,
        [req.params.id, userId],
      );
      const o = old.rows[0];
      if (!o) return null;
      const grants = await client.query<{ namespace_id: string; scopes: string[] }>(
        `SELECT namespace_id, scopes FROM namespace_token_grants WHERE token_id = $1`,
        [req.params.id],
      );
      const t = await issueToken(client, userId, { label: o.label, expiresInDays: o.days, rate: o.rate_limit_per_hour, grants: grants.rows, rotatedFrom: req.params.id });
      await client.query(`UPDATE namespace_tokens SET revoked_at = now() WHERE id = $1`, [req.params.id]);
      return { o, t };
    });
    if (!rotated) return reply.code(404).send({ error: "not_found" });
    const { o, t } = rotated;
    await audit(db, { kind: "user", userId }, "namespace_token.rotate", { old_prefix: o.token_prefix, new_prefix: t.prefix }, { kind: "namespace_token", id: t.id });
    return reply.code(201).send({ ...t, label: o.label, rotated_from: req.params.id });
  });
}
