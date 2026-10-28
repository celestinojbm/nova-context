import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { memoryQueryTerms } from "../../src/routes-namespaces.js";
import { createUser, type TestUser } from "./helpers.js";

/** M20: GET /memory?q= ranks with tsvector + ts_rank; trigram only as fallback. */
const databaseUrl = process.env.DATABASE_URL;

describe("memoryQueryTerms", () => {
  it("drops EN/ES stopwords and keeps the tsquery safe", () => {
    expect(memoryQueryTerms("¿Qué coche tiene el usuario? & | !")).toEqual([
      "coche",
      "tiene",
      "usuario",
    ]);
    expect(memoryQueryTerms("the")).toEqual(["the"]);
  });
});

describe.skipIf(!databaseUrl)("M20: memory full-text ranking", () => {
  let app: FastifyInstance;
  let u: TestUser;
  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      ocr: null,
      env: loadEnv({ DATABASE_URL: databaseUrl }),
    });
    await app.ready();
    u = await createUser(app, `fts-m20-${Date.now()}@test.local`);
    expect(
      (
        await u.inject({
          method: "POST",
          url: "/v1/namespaces",
          payload: { slug: "asistente/claude", kind: "assistant" },
        })
      ).statusCode,
    ).toBe(201);
    for (const content of [
      "Tiene un perro llamado Toby",
      "Su coche es un Mazda rojo",
      "Vive en Caracas y su coche anterior era un Fiat",
      "Le gusta el café",
    ])
      expect(
        (
          await u.inject({
            method: "POST",
            url: "/v1/namespaces/asistente/claude/memory",
            payload: { content },
          })
        ).statusCode,
      ).toBe(201);
  });
  afterAll(async () => {
    await app?.close();
  });
  const search = async (q: string) =>
    (
      (
        await u.inject({
          method: "GET",
          url: `/v1/namespaces/asistente/claude/memory?q=${encodeURIComponent(q)}`,
        })
      ).json() as { items: { content: string }[] }
    ).items.map((i) => i.content);

  it("ranks by ts_rank across words, not substring order", async () => {
    const r = await search("coche Mazda");
    expect(r[0]).toBe("Su coche es un Mazda rojo");
    expect(r).toContain("Vive en Caracas y su coche anterior era un Fiat");
    expect(r).not.toContain("Le gusta el café");
  });
  it("falls back to trigrams for typos", async () => {
    expect(await search("Mazdaa")).toContain("Su coche es un Mazda rojo");
  });
});
