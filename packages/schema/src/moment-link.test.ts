import { describe, expect, it } from "vitest";
import { listMomentsQuerySchema } from "./context-moment.js";
import { memorySearchRequestSchema } from "./search.js";

const projectId = "0b9f1c52-4a53-4d4e-8f55-1c1f0f3a9a11";

describe("listMomentsQuerySchema", () => {
  it("sin link ni project_id conserva el listado histórico", () => {
    const parsed = listMomentsQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.link).toBeUndefined();
    expect(parsed.project_id).toBeUndefined();
  });

  it("acepta link=unlinked o linked, y project_id suelto", () => {
    expect(listMomentsQuerySchema.parse({ link: "unlinked" }).link).toBe("unlinked");
    expect(listMomentsQuerySchema.parse({ link: "linked" }).link).toBe("linked");
    expect(listMomentsQuerySchema.parse({ project_id: projectId }).project_id).toBe(projectId);
  });

  it("rechaza un link desconocido, un uuid inválido y la combinación de ambos filtros", () => {
    expect(listMomentsQuerySchema.safeParse({ link: "all" }).success).toBe(false);
    expect(listMomentsQuerySchema.safeParse({ link: "" }).success).toBe(false);
    expect(listMomentsQuerySchema.safeParse({ project_id: "nope" }).success).toBe(false);
    expect(
      listMomentsQuerySchema.safeParse({ project_id: projectId, link: "unlinked" }).success,
    ).toBe(false);
  });

  it("coacciona limit desde query string y respeta el tope", () => {
    expect(listMomentsQuerySchema.parse({ limit: "20" }).limit).toBe(20);
    expect(listMomentsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listMomentsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("memorySearchRequestSchema link", () => {
  it("una búsqueda sin link no cambia de forma", () => {
    const parsed = memorySearchRequestSchema.parse({ query: "pricing" });
    expect(parsed.query).toBe("pricing");
    expect(parsed.link).toBeUndefined();
    expect(parsed.limit).toBe(20);
  });

  it("acepta el corte y rechaza combinarlo con project_id o un valor desconocido", () => {
    expect(memorySearchRequestSchema.parse({ link: "unlinked" }).link).toBe("unlinked");
    expect(memorySearchRequestSchema.parse({ project_id: projectId }).project_id).toBe(projectId);
    expect(
      memorySearchRequestSchema.safeParse({ project_id: projectId, link: "linked" }).success,
    ).toBe(false);
    expect(memorySearchRequestSchema.safeParse({ link: "none" }).success).toBe(false);
    expect(memorySearchRequestSchema.safeParse({ query: "x", extra: true }).success).toBe(false);
  });
});
