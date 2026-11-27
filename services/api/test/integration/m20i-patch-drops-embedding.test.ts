import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { authedInject, createUser, type AuthedInject, type TestUser } from "./helpers.js";

/**
 * M20i follow-up (docs/design/m20e-embeddings.md, "Límite conocido"): a PATCH
 * that changes a fact's text deletes that fact's vectors in the same statement,
 * so a vector of the old text never outlives the edit. Status-only PATCHes,
 * no-op edits, denied or foreign PATCHes keep the vector. Both the historical
 * path (lock off) and the M20h locked path (lock on) are covered.
 */
const databaseUrl = process.env.DATABASE_URL;
const MODELS = ["test/fake-384-a", "test/fake-384-b"] as const;
const vec = `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

describe.skipIf(!databaseUrl)("M20i: PATCH of a fact's text drops its stale vectors", () => {
  let appOff: FastifyInstance;
  let appOn: FastifyInstance;
  let admin: pg.Client;
  let alice: TestUser;
  let bob: TestUser;
  let offI: AuthedInject;
  let onI: AuthedInject;
  let tokenI: AuthedInject;
  const ns = "asistente/m20i-patch";
  const base = `/v1/namespaces/${ns}/memory`;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    appOff = await buildApp({ ocr: null, env: loadEnv({ DATABASE_URL: databaseUrl }) });
    appOn = await buildApp({ ocr: null, env: loadEnv({ DATABASE_URL: databaseUrl, NOVA_MEMORY_ITEM_LOCK: "on" }) });
    await Promise.all([appOff.ready(), appOn.ready()]);
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    alice = await createUser(appOff, `alice-m20i-patch-${Date.now()}@test.local`);
    bob = await createUser(appOff, `bob-m20i-patch-${Date.now()}@test.local`);
    offI = alice.inject;
    onI = authedInject(appOn, alice.token);
    expect((await offI({ method: "POST", url: "/v1/namespaces", payload: { slug: ns, kind: "assistant" } })).statusCode).toBe(201);
    const issued = await offI({
      method: "POST",
      url: "/v1/namespace-tokens",
      payload: { label: "m20i-patch", grants: [{ namespace: ns, scopes: ["memory:read", "memory:write"] }] },
    });
    expect(issued.statusCode).toBe(201);
    tokenI = authedInject(appOff, (issued.json() as { token: string }).token);
  });
  afterAll(async () => {
    await admin?.end();
    await Promise.all([appOff?.close(), appOn?.close()]);
  });

  /** Creates a fact through the API and gives it one vector per model. */
  async function factWithVectors(inject: AuthedInject, content: string): Promise<string> {
    const res = await inject({ method: "POST", url: base, payload: { content } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    for (const model of MODELS) {
      await admin.query(
        `INSERT INTO memory_item_embeddings (memory_item_id, model, embedding, content_sha256) VALUES ($1, $2, $3::vector, 'h')`,
        [id, model, vec],
      );
    }
    return id;
  }
  const vectors = async (id: string) =>
    (await admin.query<{ n: number }>(`SELECT count(*)::int n FROM memory_item_embeddings WHERE memory_item_id = $1`, [id])).rows[0]!.n;
  const content = async (id: string) =>
    (await admin.query<{ content: string }>(`SELECT content FROM memory_items WHERE id = $1`, [id])).rows[0]!.content;

  it("lock off: editing the text deletes the vectors of every model; a sibling fact keeps its own", async () => {
    const id = await factWithVectors(offI, "Me gusta el jazz");
    const sibling = await factWithVectors(offI, "Bebo té verde");
    const res = await offI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "Mi coche nuevo es un Honda" } });
    expect(res.statusCode).toBe(200);
    expect(await content(id)).toBe("Mi coche nuevo es un Honda");
    expect(await vectors(id)).toBe(0);
    expect(await vectors(sibling)).toBe(2);
  });

  it("lock on (M20h path): editing the text deletes the vectors too", async () => {
    const id = await factWithVectors(onI, "Vivo en Lima");
    const res = await onI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "Vivo en Cusco" } });
    expect(res.statusCode).toBe(200);
    expect(await content(id)).toBe("Vivo en Cusco");
    expect(await vectors(id)).toBe(0);
  });

  it("a status-only PATCH keeps the vectors (the embedded text did not change)", async () => {
    for (const inject of [offI, onI]) {
      const id = await factWithVectors(inject, "Trabajo en remoto");
      const res = await inject({ method: "PATCH", url: `${base}/${id}`, payload: { status: "contested" } });
      expect(res.statusCode).toBe(200);
      expect(await vectors(id)).toBe(2);
    }
  });

  it("an edit that ends in the same stored text (after trim) keeps the vectors", async () => {
    const id = await factWithVectors(offI, "Corro los domingos");
    const res = await offI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "  Corro los domingos  " } });
    expect(res.statusCode).toBe(200);
    expect(await content(id)).toBe("Corro los domingos");
    expect(await vectors(id)).toBe(2);
  });

  it("a case-only edit is new text for the model: vectors are dropped", async () => {
    const id = await factWithVectors(offI, "corro los sábados");
    expect((await offI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "Corro los sábados" } })).statusCode).toBe(200);
    expect(await vectors(id)).toBe(0);
  });

  it("a token editing an assistant fact drops its vectors", async () => {
    const id = await factWithVectors(tokenI, "El usuario prefiere respuestas cortas");
    const res = await tokenI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "El usuario prefiere respuestas largas" } });
    expect(res.statusCode).toBe(200);
    expect(await vectors(id)).toBe(0);
  });

  it("a token denied on a user fact (403) leaves text and vectors intact", async () => {
    const id = await factWithVectors(offI, "Mi cumpleaños es en mayo");
    const res = await tokenI({ method: "PATCH", url: `${base}/${id}`, payload: { content: "otro texto" } });
    expect(res.statusCode).toBe(403);
    expect(await content(id)).toBe("Mi cumpleaños es en mayo");
    expect(await vectors(id)).toBe(2);
  });

  it("another user's PATCH is a 404 and deletes nothing", async () => {
    const id = await factWithVectors(offI, "Tengo un perro");
    const res = await bob.inject({ method: "PATCH", url: `${base}/${id}`, payload: { content: "Tengo un gato" } });
    expect(res.statusCode).toBe(404);
    expect(await content(id)).toBe("Tengo un perro");
    expect(await vectors(id)).toBe(2);
  });
});
