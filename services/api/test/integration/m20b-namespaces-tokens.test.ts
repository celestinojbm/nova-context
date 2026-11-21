import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { authedInject, createUser, type TestUser } from "./helpers.js";

/**
 * M20b (docs/design/memoria-m20.md §2, §2.4): namespaces, per-namespace
 * tokens (scopes, user-fact protection, revocation, rotation, rate limit,
 * content-free audit) and nova-memory-md/v1 export excluding local_only.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("M20b: namespaces + namespace tokens", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let alice: TestUser;
  let bob: TestUser;
  const SECRET = `zebrafacts${Date.now().toString(36).replace(/\d/g, "q")}`;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({ ocr: null, env: loadEnv({ DATABASE_URL: databaseUrl }) });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    alice = await createUser(app, `alice-m20b-${Date.now()}@test.local`);
    bob = await createUser(app, `bob-m20b-${Date.now()}@test.local`);
  });
  afterAll(async () => {
    await db?.end();
    await app?.close();
  });

  async function issue(user: TestUser, grants: unknown, extra: Record<string, unknown> = {}) {
    const res = await user.inject({ method: "POST", url: "/v1/namespace-tokens", payload: { label: "claude-desktop", grants, ...extra } });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; token: string; prefix: string };
  }

  it("lists default + project namespaces and creates/renames/archives custom ones", async () => {
    const list = await alice.inject({ method: "GET", url: "/v1/namespaces" });
    expect(list.statusCode).toBe(200);
    const slugs = (list.json().items as Array<{ slug: string; kind: string }>).map((n) => n.slug);
    expect(slugs).toContain("default");
    expect(slugs.some((s) => s.startsWith("proyecto/"))).toBe(true);

    expect((await alice.inject({ method: "POST", url: "/v1/namespaces", payload: { slug: "asistente/claude", kind: "assistant" } })).statusCode).toBe(201);
    expect((await alice.inject({ method: "POST", url: "/v1/namespaces", payload: { slug: "asistente/claude", kind: "assistant" } })).statusCode).toBe(409);
    expect((await alice.inject({ method: "POST", url: "/v1/namespaces", payload: { slug: "bad/memory" } })).statusCode).toBe(400);
    expect((await alice.inject({ method: "POST", url: "/v1/namespaces", payload: { slug: "tmp" } })).statusCode).toBe(201);
    expect((await alice.inject({ method: "PATCH", url: "/v1/namespaces/tmp", payload: { slug: "tmp2" } })).statusCode).toBe(200);
    expect((await alice.inject({ method: "DELETE", url: "/v1/namespaces/tmp2" })).statusCode).toBe(200);
    expect((await alice.inject({ method: "DELETE", url: "/v1/namespaces/default" })).statusCode).toBe(409);
    // Bob cannot see Alice's namespace.
    expect((await bob.inject({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(404);
  });

  it("enforces token scopes and never lets memory:write touch user facts", async () => {
    const userFact = await alice.inject({ method: "POST", url: "/v1/namespaces/asistente/claude/memory", payload: { content: "Prefiere asientos de pasillo" } });
    expect(userFact.statusCode).toBe(201);
    expect(userFact.json().author).toBe("user");

    const ro = await issue(alice, [{ namespace: "asistente/claude", scopes: ["memory:read"] }]);
    const roI = authedInject(app, ro.token);
    expect((await roI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(200);
    expect((await roI({ method: "POST", url: "/v1/namespaces/asistente/claude/memory", payload: { content: "x" } })).statusCode).toBe(403);
    expect((await roI({ method: "GET", url: "/v1/export/namespace/asistente/claude.md" })).statusCode).toBe(403);
    // Not granted / account surfaces → 404 (no existence leak).
    expect((await roI({ method: "GET", url: "/v1/namespaces/default/memory" })).statusCode).toBe(404);
    expect((await roI({ method: "GET", url: "/v1/projects" })).statusCode).toBe(404);
    expect((await roI({ method: "GET", url: "/v1/context/moments" })).statusCode).toBe(404);
    expect((await roI({ method: "GET", url: "/v1/namespaces" })).statusCode).toBe(404);
    expect((await roI({ method: "POST", url: "/v1/namespace-tokens", payload: {} })).statusCode).toBe(404);

    const rw = await issue(alice, [{ namespace: "asistente/claude", scopes: ["memory:read", "memory:write", "memory:export"] }]);
    const rwI = authedInject(app, rw.token);
    const created = await rwI({ method: "POST", url: "/v1/namespaces/asistente/claude/memory", payload: { content: `${SECRET} usa pnpm` } });
    expect(created.statusCode).toBe(201);
    expect(created.json().author).toBe("assistant");
    // Own assistant fact: editable. User fact: protected.
    expect((await rwI({ method: "PATCH", url: `/v1/namespaces/asistente/claude/memory/${created.json().id}`, payload: { status: "superseded" } })).statusCode).toBe(200);
    const denied = await rwI({ method: "PATCH", url: `/v1/namespaces/asistente/claude/memory/${userFact.json().id}`, payload: { content: "hijacked" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("user_fact_protected");
    const still = await db.query(`SELECT content, author FROM memory_items WHERE id = $1`, [userFact.json().id]);
    expect(still.rows[0]).toEqual({ content: "Prefiere asientos de pasillo", author: "user" });

    // Bob's session cannot read Alice's facts; Alice's token can't be used for Bob's namespace.
    expect((await bob.inject({ method: "PATCH", url: `/v1/namespaces/asistente/claude/memory/${userFact.json().id}`, payload: { status: "contested" } })).statusCode).toBe(404);

    // Audit: actor token:<prefix>, no content.
    const audit = await db.query<{ detail: unknown }>(
      `SELECT detail FROM audit_log WHERE user_id = $1 AND event_type LIKE 'namespace_token.%'`,
      [alice.userId],
    );
    const blob = JSON.stringify(audit.rows);
    expect(blob).toContain(`token:${rw.prefix}`);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("pasillo");
    expect(blob).not.toContain(rw.token);
    const stored = await db.query(`SELECT token_hash FROM namespace_tokens WHERE id = $1`, [rw.id]);
    expect(stored.rows[0].token_hash).not.toContain(rw.token);
  });

  it("revocation and rotation take effect immediately", async () => {
    const t = await issue(alice, [{ namespace: "asistente/claude", scopes: ["memory:read"] }]);
    const tI = authedInject(app, t.token);
    expect((await tI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(200);
    // Bob cannot revoke Alice's token.
    expect((await bob.inject({ method: "DELETE", url: `/v1/namespace-tokens/${t.id}` })).statusCode).toBe(404);
    const rot = await alice.inject({ method: "POST", url: `/v1/namespace-tokens/${t.id}/rotate` });
    expect(rot.statusCode).toBe(201);
    expect((await tI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(401);
    const nI = authedInject(app, rot.json().token);
    expect((await nI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(200);
    expect((await alice.inject({ method: "DELETE", url: `/v1/namespace-tokens/${rot.json().id}` })).statusCode).toBe(200);
    expect((await nI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(401);
    // Archiving a namespace drops its grants.
    await alice.inject({ method: "POST", url: "/v1/namespaces", payload: { slug: "efimero" } });
    const e = await issue(alice, [{ namespace: "efimero", scopes: ["memory:read"] }]);
    await alice.inject({ method: "DELETE", url: "/v1/namespaces/efimero" });
    expect((await authedInject(app, e.token)({ method: "GET", url: "/v1/namespaces/efimero/memory" })).statusCode).toBe(404);
    // Expired tokens are rejected.
    const x = await issue(alice, [{ namespace: "asistente/claude", scopes: ["memory:read"] }]);
    await db.query(`UPDATE namespace_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`, [x.id]);
    expect((await authedInject(app, x.token)({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(401);
    const list = await alice.inject({ method: "GET", url: "/v1/namespace-tokens" });
    expect(JSON.stringify(list.json())).not.toContain("token_hash");
  });

  it("applies the per-token usage limit", async () => {
    const t = await issue(alice, [{ namespace: "asistente/claude", scopes: ["memory:read"] }], { rate_limit_per_hour: 2 });
    const tI = authedInject(app, t.token);
    expect((await tI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(200);
    expect((await tI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(200);
    expect((await tI({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(429);
  });

  it("exports nova-memory-md/v1 and excludes local_only", async () => {
    await alice.inject({ method: "POST", url: "/v1/namespaces/default/memory", payload: { content: "Hecho exportable" } });
    const ns = await db.query<{ id: string }>(`SELECT id FROM memory_namespaces WHERE user_id = $1 AND slug = 'default'`, [alice.userId]);
    await db.query(
      `INSERT INTO memory_items (user_id, layer, content, author, local_only, namespace_id) VALUES ($1, 'semantic', 'Secreto solo local', 'model', true, $2)`,
      [alice.userId, ns.rows[0]!.id],
    );
    const res = await alice.inject({ method: "GET", url: "/v1/export/namespace/default.md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("format: nova-memory-md/v1");
    expect(res.body).toContain("Hecho exportable");
    expect(res.body).not.toContain("Secreto solo local");
    // Session JSON read still sees it (it's the user's own box); a token does not.
    const own = await alice.inject({ method: "GET", url: "/v1/namespaces/default/memory" });
    expect(own.body).toContain("Secreto solo local");
    const t = await issue(alice, [{ namespace: "default", scopes: ["memory:read", "memory:export"] }]);
    const tI = authedInject(app, t.token);
    expect((await tI({ method: "GET", url: "/v1/namespaces/default/memory" })).body).not.toContain("Secreto solo local");
    const exp = await tI({ method: "GET", url: "/v1/export/namespace/default.md" });
    expect(exp.statusCode).toBe(200);
    expect(exp.body).not.toContain("Secreto solo local");
    const audited = await db.query(`SELECT 1 FROM audit_log WHERE user_id = $1 AND event_type = 'export' AND detail->>'format' = 'nova-memory-md/v1'`, [alice.userId]);
    expect(audited.rowCount).toBeGreaterThan(0);
  });

  it("a local_only project namespace refuses export to a token", async () => {
    const projects = await alice.inject({ method: "GET", url: "/v1/projects" });
    const pid = projects.json().items[0].id as string;
    await db.query(`UPDATE projects SET local_only = true WHERE id = $1`, [pid]);
    const slug = `proyecto/${pid.slice(0, 8)}`;
    await alice.inject({ method: "GET", url: "/v1/namespaces" });
    const t = await issue(alice, [{ namespace: slug, scopes: ["memory:export"] }]);
    expect((await authedInject(app, t.token)({ method: "GET", url: `/v1/export/namespace/${slug}.md` })).statusCode).toBe(403);
    await db.query(`UPDATE projects SET local_only = false WHERE id = $1`, [pid]);
  });

  it("facts of an archived project never fall into 'default' (fail closed)", async () => {
    const MARK = `archivedfact${Date.now().toString(36)}`;
    const p = await db.query<{ id: string }>(`INSERT INTO projects (user_id, name) VALUES ($1, 'M20b archivado') RETURNING id`, [alice.userId]);
    const pid = p.rows[0]!.id;
    const m = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, project_id, source_mode) VALUES ($1, $2, 'instant_capture') RETURNING id`,
      [alice.userId, pid],
    );
    await db.query(`UPDATE projects SET archived = true WHERE id = $1`, [pid]);
    const fact = await db.query<{ id: string }>(
      `INSERT INTO memory_items (user_id, moment_id, layer, content, author) VALUES ($1, $2, 'semantic', $3, 'model') RETURNING id`,
      [alice.userId, m.rows[0]!.id, MARK],
    );
    await alice.inject({ method: "GET", url: "/v1/namespaces" }); // runs the lazy assignment
    const row = await db.query(`SELECT namespace_id FROM memory_items WHERE id = $1`, [fact.rows[0]!.id]);
    expect(row.rows[0].namespace_id).toBeNull();
    const t = await issue(alice, [{ namespace: "default", scopes: ["memory:read", "memory:export"] }]);
    const tI = authedInject(app, t.token);
    expect((await tI({ method: "GET", url: "/v1/namespaces/default/memory?status=all" })).body).not.toContain(MARK);
    expect((await tI({ method: "GET", url: "/v1/export/namespace/default.md" })).body).not.toContain(MARK);
    // Unarchived: the project gets its namespace and the fact lands there, not in 'default'.
    await db.query(`UPDATE projects SET archived = false WHERE id = $1`, [pid]);
    await alice.inject({ method: "GET", url: "/v1/namespaces" });
    const after = await db.query<{ slug: string }>(
      `SELECT n.slug FROM memory_items mi JOIN memory_namespaces n ON n.id = mi.namespace_id WHERE mi.id = $1`,
      [fact.rows[0]!.id],
    );
    expect(after.rows[0]!.slug).toBe(`proyecto/${pid.slice(0, 8)}`);
  });

  it("token issuance is all-or-nothing: a duplicated namespace is a 400 and leaves no token row", async () => {
    const count = async () =>
      (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM namespace_tokens WHERE user_id = $1`, [alice.userId])).rows[0]!.c;
    const before = await count();
    const res = await alice.inject({
      method: "POST",
      url: "/v1/namespace-tokens",
      payload: { label: "dup", grants: [{ namespace: "default", scopes: ["memory:read"] }, { namespace: "default", scopes: ["memory:write"] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("duplicate_namespace_grant");
    expect(await count()).toBe(before);
  });

  it("concurrent rotations mint exactly one successor", async () => {
    const t = await issue(alice, [{ namespace: "asistente/claude", scopes: ["memory:read"] }]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => alice.inject({ method: "POST", url: `/v1/namespace-tokens/${t.id}/rotate` })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 404)).toHaveLength(4);
    const successors = await db.query(`SELECT 1 FROM namespace_tokens WHERE rotated_from = $1`, [t.id]);
    expect(successors.rowCount).toBe(1);
    expect((await authedInject(app, t.token)({ method: "GET", url: "/v1/namespaces/asistente/claude/memory" })).statusCode).toBe(401);
  });
});

/**
 * 0014 is reversible: down script → exact pre-0014 schema; re-applying 0014
 * backfills with the fail-closed rule. Runs in a throwaway database so the
 * shared test DB is never touched.
 */
describe.skipIf(!databaseUrl)("M20b: migration 0014 round trip (up → down → up)", () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const tmpName = `nova_m20b_rt_${Date.now().toString(36)}`;
  let admin: pg.Client;
  let tmpUrl: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${tmpName}`);
    const u = new URL(databaseUrl!);
    u.pathname = `/${tmpName}`;
    tmpUrl = u.toString();
  });
  afterAll(async () => {
    await admin?.query(`DROP DATABASE IF EXISTS ${tmpName} WITH (FORCE)`);
    await admin?.end();
  });

  it("drops every 0014 object, keeps facts, and re-applies cleanly", async () => {
    await migrate(tmpUrl);
    const db = new pg.Client({ connectionString: tmpUrl });
    await db.connect();
    try {
      const down = await readFile(join(migrationsDir, "down/0014_m20b_namespaces_tokens.down.sql"), "utf8");
      await db.query("BEGIN");
      await db.query(down);
      await db.query("COMMIT");

      const tables = await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('memory_namespaces','namespace_tokens','namespace_token_grants')`,
      );
      expect(tables.rowCount).toBe(0);
      const col = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'memory_items' AND column_name = 'namespace_id'`,
      );
      expect(col.rowCount).toBe(0);
      expect((await db.query(`SELECT 1 FROM schema_migrations WHERE name = '0014_m20b_namespaces_tokens.sql'`)).rowCount).toBe(0);

      // Pre-0014 data: a loose fact, a live-project fact, an archived-project fact.
      const user = (await db.query<{ id: string }>(`INSERT INTO users (email) VALUES ('rt@test.local') RETURNING id`)).rows[0]!.id;
      const live = (await db.query<{ id: string }>(`INSERT INTO projects (user_id, name) VALUES ($1, 'live') RETURNING id`, [user])).rows[0]!.id;
      const arch = (await db.query<{ id: string }>(`INSERT INTO projects (user_id, name, archived) VALUES ($1, 'arch', true) RETURNING id`, [user])).rows[0]!.id;
      const moment = async (pid: string) =>
        (await db.query<{ id: string }>(`INSERT INTO context_moments (user_id, project_id, source_mode) VALUES ($1, $2, 'instant_capture') RETURNING id`, [user, pid])).rows[0]!.id;
      const fact = async (content: string, momentId: string | null) =>
        (await db.query<{ id: string }>(
          `INSERT INTO memory_items (user_id, moment_id, layer, content, author) VALUES ($1, $2, 'semantic', $3, 'model') RETURNING id`,
          [user, momentId, content],
        )).rows[0]!.id;
      const loose = await fact("loose", null);
      const inLive = await fact("live", await moment(live));
      const inArch = await fact("arch", await moment(arch));

      expect(await migrate(tmpUrl)).toEqual(["0014_m20b_namespaces_tokens.sql"]);
      const ns = async (id: string) =>
        (await db.query<{ slug: string | null }>(
          `SELECT n.slug FROM memory_items mi LEFT JOIN memory_namespaces n ON n.id = mi.namespace_id WHERE mi.id = $1`,
          [id],
        )).rows[0]!.slug;
      expect(await ns(loose)).toBe("default");
      expect(await ns(inLive)).toBe(`proyecto/${live.slice(0, 8)}`);
      expect(await ns(inArch)).toBeNull();
    } finally {
      await db.end();
    }
  });
});
