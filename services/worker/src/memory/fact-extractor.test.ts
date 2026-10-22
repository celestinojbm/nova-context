import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractFacts, factHash, normalizeFact } from "./fact-extractor.js";

interface Moment {
  text: string;
  redaction_state: string;
  local_only: boolean;
  expected_facts: string[];
}
interface Case { id: string; category: string; moments: Moment[]; expected_relation: string }

const dataset = JSON.parse(
  readFileSync(new URL("../../eval/m20-synthetic-cases.json", import.meta.url), "utf8"),
) as { cases: Case[] };

/** Mirrors writeMomentFacts' gate: pending redaction is never read. */
function extractGated(m: Moment): string[] {
  if (m.redaction_state !== "applied" && m.redaction_state !== "skipped") return [];
  return extractFacts(m.text).map((f) => f.content);
}

describe("M20a fact extractor — unit", () => {
  it("is deterministic and dedupes within a moment", () => {
    const facts = extractFacts("Lucía vive en Valencia. Lucía vive en Valencia.");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("statement");
  });
  it("drops questions, imperatives and redaction markers", () => {
    expect(extractFacts("¿Dónde vive Lucía?")).toEqual([]);
    expect(extractFacts("Compara estos precios con la competencia.")).toEqual([]);
    expect(extractFacts("La clave es [REDACTED] para todos.")).toEqual([]);
  });
  it("classifies preferences, decisions and key:value attributes", () => {
    expect(extractFacts("Prefiero café sin azúcar.")[0]!.kind).toBe("preference");
    expect(extractFacts("Decidimos usar Postgres para el MVP.")[0]!.kind).toBe("decision");
    expect(extractFacts("Precio del plan Pro: 49 USD al mes")[0]!.kind).toBe("attribute");
  });
  it("hash ignores case, whitespace and trailing punctuation", () => {
    expect(factHash("Lucía  vive en Valencia.")).toBe(factHash("lucía vive en valencia"));
    expect(normalizeFact("  A   B. ")).toBe("a b");
  });
  it("caps facts per moment", () => {
    const text = Array.from({ length: 40 }, (_, i) => `El servicio ${i} usa el puerto ${i}.`).join(" ");
    expect(extractFacts(text).length).toBe(20);
  });
});

describe("M20a — 50 synthetic evaluation cases", () => {
  it("has exactly 50 cases across 5 categories", () => {
    expect(dataset.cases).toHaveLength(50);
    expect(new Set(dataset.cases.map((c) => c.category)).size).toBe(5);
  });
  for (const c of dataset.cases) {
    it(`${c.id} (${c.category}) extracts the expected facts`, () => {
      for (const m of c.moments) expect(extractGated(m)).toEqual(m.expected_facts);
      if (c.category === "duplicate_exact") {
        const [a, b] = c.moments.map((m) => extractFacts(m.text)[0]!.content_hash);
        expect(a).toBe(b);
      }
    });
  }
});
