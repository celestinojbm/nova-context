import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * Timeline de revisión (Horizonte 2): poder separar capturas ya vinculadas
 * de las que siguen sin proyecto, sin cambiar el listado por defecto.
 * Postgres real. Cuentas nuevas para no mezclar datos de otras suites.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("moment link filter", () => {
  let app: FastifyInstance;
  let alice: TestUser;
  let bob: TestUser;
  const stamp = Date.now();
  let projectId: string;
  let linkedId: string;
  let unlinkedId: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_RATE_LIMIT_PREFIX: `test-link-${stamp}`,
      }),
    });
    await app.ready();
    alice = await createUser(app, `link-alice-${stamp}@example.test`);
    bob = await createUser(app, `link-bob-${stamp}@example.test`);

    const created = await alice.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: `Pricing ${stamp}` },
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id as string;

    linkedId = await capture(alice, projectId, "linked capture about pricing limits");
    unlinkedId = await capture(alice, null, "unlinked capture about pricing limits");
    await capture(bob, null, "bob unlinked capture about pricing limits");
  });

  afterAll(async () => {
    await app?.close();
  });

  async function capture(user: TestUser, project: string | null, text: string): Promise<string> {
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://example.com/pricing", title: "Pricing" },
        extracted_text: text,
        intent_text: text,
        ...(project ? { project_id: project } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  function ids(res: { json: () => { items: Array<{ id: string }> } }): string[] {
    return res.json().items.map((item) => item.id);
  }

  it("sin link devuelve vinculadas y sin vincular (comportamiento por defecto)", async () => {
    const res = await alice.inject({ method: "GET", url: "/v1/context/moments" });
    expect(res.statusCode).toBe(200);
    const found = ids(res);
    expect(found).toContain(linkedId);
    expect(found).toContain(unlinkedId);
  });

  it("link=unlinked solo devuelve project_id null, y no las de otro usuario", async () => {
    const res = await alice.inject({ method: "GET", url: "/v1/context/moments?link=unlinked" });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; project_id: string | null }>;
    expect(items.map((item) => item.id)).toEqual([unlinkedId]);
    expect(items.every((item) => item.project_id === null)).toBe(true);
  });

  it("link=linked y project_id siguen acotando al proyecto", async () => {
    const linked = await alice.inject({ method: "GET", url: "/v1/context/moments?link=linked" });
    expect(linked.statusCode).toBe(200);
    expect(ids(linked)).toEqual([linkedId]);

    const byProject = await alice.inject({
      method: "GET",
      url: `/v1/context/moments?project_id=${projectId}`,
    });
    expect(byProject.statusCode).toBe(200);
    expect(ids(byProject)).toEqual([linkedId]);
  });

  it("rechaza link desconocido y la combinación con project_id", async () => {
    expect(
      (await alice.inject({ method: "GET", url: "/v1/context/moments?link=all" })).statusCode,
    ).toBe(400);
    expect(
      (
        await alice.inject({
          method: "GET",
          url: `/v1/context/moments?project_id=${projectId}&link=unlinked`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("la búsqueda aplica el mismo corte y no reescribe el proyecto", async () => {
    const res = await alice.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { query: "pricing limits", link: "unlinked", limit: 20 },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; project_id: string | null }>;
    expect(items.map((item) => item.id)).toEqual([unlinkedId]);
    expect(items[0]?.project_id).toBeNull();

    const both = await alice.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { project_id: projectId, link: "linked" },
    });
    expect(both.statusCode).toBe(400);
  });

  it("tras vincular, la captura sale de unlinked y entra en el proyecto", async () => {
    const patched = await alice.inject({
      method: "PATCH",
      url: `/v1/context/moments/${unlinkedId}`,
      payload: { project_id: projectId },
    });
    expect(patched.statusCode).toBe(200);

    const unlinked = await alice.inject({
      method: "GET",
      url: "/v1/context/moments?link=unlinked",
    });
    expect(ids(unlinked)).not.toContain(unlinkedId);

    const byProject = await alice.inject({
      method: "GET",
      url: `/v1/context/moments?project_id=${projectId}`,
    });
    expect(ids(byProject)).toEqual(expect.arrayContaining([linkedId, unlinkedId]));
  });
});
