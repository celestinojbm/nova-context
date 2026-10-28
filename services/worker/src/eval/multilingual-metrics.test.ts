import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prefixFor } from "../memory/embeddings.js";
import { prAt, sweep } from "./multilingual-metrics.js";

describe("M20f multilingual eval — pure parts (no model in CI)", () => {
  it("e5 gets query:/passage: prefixes; other models raw text", () => {
    expect(prefixFor("Xenova/multilingual-e5-small", ["hola"], "passage")).toEqual(["passage: hola"]);
    expect(prefixFor("Xenova/multilingual-e5-small", ["hola"])).toEqual(["query: hola"]);
    expect(prefixFor("Xenova/paraphrase-multilingual-MiniLM-L12-v2", ["hola"], "passage")).toEqual(["hola"]);
  });
  it("precision/recall and sweep", () => {
    const pairs = [{ label: 1 as const, score: 0.9 }, { label: 1 as const, score: 0.6 }, { label: 0 as const, score: 0.7 }, { label: 0 as const, score: 0.1 }];
    expect(prAt(pairs, 0.65)).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
    const s = sweep(pairs);
    expect(s.zeroFp).toMatchObject({ fp: 0, recall: 0.5 });
    expect(s.bestF1.f1).toBeGreaterThanOrEqual(0.66);
  });
  it("Spanish dataset: 60 pairs, 30 positive, unique ids", () => {
    const d = JSON.parse(readFileSync(new URL("../../eval/m20-multilingual-es-cases.json", import.meta.url), "utf8"));
    expect(d.cases).toHaveLength(60);
    expect(d.cases.filter((c: { label: number }) => c.label === 1)).toHaveLength(30);
    expect(new Set(d.cases.map((c: { id: string }) => c.id)).size).toBe(60);
  });
});
