import { describe, expect, it } from "vitest";
import {
  createProjectRequestSchema,
  updateContextMomentRequestSchema,
} from "./project-write.js";

describe("createProjectRequestSchema", () => {
  it("recorta el nombre y aplica defaults", () => {
    const r = createProjectRequestSchema.parse({ name: "  Acme  " });
    expect(r).toEqual({ name: "Acme", description: null, local_only: false });
  });

  it("normaliza descripción vacía a null y acepta local_only", () => {
    const r = createProjectRequestSchema.parse({ name: "X", description: "   ", local_only: true });
    expect(r.description).toBeNull();
    expect(r.local_only).toBe(true);
  });

  it("rechaza nombre vacío, demasiado largo o campos desconocidos", () => {
    expect(createProjectRequestSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ name: "a".repeat(121) }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ name: "ok", archived: true }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("updateContextMomentRequestSchema", () => {
  const uuid = "0b9f1c52-4a53-4d4e-8f55-1c1f0f3a9a11";

  it("acepta project_id, null (desvincular) e intent_text", () => {
    expect(updateContextMomentRequestSchema.safeParse({ project_id: uuid }).success).toBe(true);
    expect(updateContextMomentRequestSchema.safeParse({ project_id: null }).success).toBe(true);
    expect(updateContextMomentRequestSchema.safeParse({ intent_text: "hola" }).success).toBe(true);
    expect(updateContextMomentRequestSchema.safeParse({ intent_text: null }).success).toBe(true);
  });

  it("exige al menos un campo", () => {
    expect(updateContextMomentRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rechaza uuid inválido, texto enorme y campos no editables", () => {
    expect(updateContextMomentRequestSchema.safeParse({ project_id: "no-uuid" }).success).toBe(false);
    expect(updateContextMomentRequestSchema.safeParse({ intent_text: "x".repeat(10_001) }).success).toBe(false);
    expect(updateContextMomentRequestSchema.safeParse({ extracted_text: "no" }).success).toBe(false);
    expect(updateContextMomentRequestSchema.safeParse({ summary: "no" }).success).toBe(false);
  });
});
