import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPair, THRESHOLDS, type Thresholds } from "./consolidation-rules.js";

/** M20c: calibrates THRESHOLDS on the 50 synthetic cases (pairs with 2 facts). */
interface Case { id: string; expected_relation: string; moments: { expected_facts: string[] }[] }
const cases: Case[] = JSON.parse(
  readFileSync(new URL("../../eval/m20-synthetic-cases.json", import.meta.url), "utf8"),
).cases;
const pairs = cases
  .map((c) => ({ id: c.id, exp: c.expected_relation, f: c.moments.flatMap((m) => m.expected_facts) }))
  .filter((p) => p.f.length === 2);

export function score(t: Thresholds) {
  const m = { merge: { tp: 0, fp: 0, fn: 0 }, conflict: { tp: 0, fp: 0, fn: 0 } };
  const errors: string[] = [];
  for (const p of pairs) {
    const got = classifyPair(p.f[0]!, p.f[1]!, t).relation;
    const exp = p.exp === "merge" ? "merge" : p.exp === "newer_wins" ? "conflict" : "keep";
    if (got !== exp) errors.push(`${p.id}: esperado ${exp}, obtenido ${got}`);
    for (const k of ["merge", "conflict"] as const) {
      if (got === k && exp === k) m[k].tp++;
      else if (got === k) m[k].fp++;
      else if (exp === k) m[k].fn++;
    }
  }
  const pr = (x: { tp: number; fp: number; fn: number }) => ({
    ...x,
    precision: x.tp + x.fp ? x.tp / (x.tp + x.fp) : 1,
    recall: x.tp + x.fn ? x.tp / (x.tp + x.fn) : 1,
  });
  return { merge: pr(m.merge), conflict: pr(m.conflict), errors };
}

describe("M20c calibration on synthetic cases", () => {
  it("has 40 two-fact pairs (10 privacy/noise cases yield <2 facts)", () => {
    expect(pairs.length).toBe(40);
  });

  it("chosen thresholds: merge and conflict precision = 1.0 (no false merges)", () => {
    const r = score(THRESHOLDS);
    if (process.env.M20C_PRINT) console.log(JSON.stringify(r, null, 2));
    expect(r.merge.precision).toBe(1);
    expect(r.conflict.precision).toBe(1);
    expect(r.merge.recall).toBeGreaterThanOrEqual(0.9);
    expect(r.conflict.recall).toBeGreaterThanOrEqual(0.9);
  });

  it("sweep (printed with M20C_PRINT=1)", () => {
    const rows: string[] = [];
    for (const ms of [0.4, 0.5, 0.6, 0.7]) for (const cf of [0.3, 0.4, 0.45, 0.5, 0.6, 0.7]) {
      const r = score({ candidate: 0.3, mergeSubset: ms, conflict: cf });
      rows.push(`| ${ms} | ${cf} | ${r.merge.precision.toFixed(2)} | ${r.merge.recall.toFixed(2)} | ${r.conflict.precision.toFixed(2)} | ${r.conflict.recall.toFixed(2)} |`);
    }
    if (process.env.M20C_PRINT) console.log(rows.join("\n"));
    expect(rows.length).toBe(24);
  });
});

describe("M20e: embedding cosine only adds candidates", () => {
  it("low-trigram pair above the embedding threshold → conflict (embedding_neighbor)", () => {
    expect(classifyPair("Drives a Mazda", "My new car is a Honda", THRESHOLDS, undefined, 0.8)).toMatchObject({ relation: "conflict", reason: "embedding_neighbor" });
    expect(classifyPair("Drives a Mazda", "My new car is a Honda", THRESHOLDS, undefined, 0.3).relation).toBe("keep");
    expect(classifyPair("Drives a Mazda", "My new car is a Honda").relation).toBe("keep");
  });
});
