/**
 * M20c consolidation rules (docs/design/memoria-m20.md §1.3). Pure and
 * deterministic: no embeddings, no LLM, no network. The database supplies
 * candidate pairs with pg_trgm `similarity()`; these rules decide what a pair
 * is. `trigramSimilarity` mirrors pg_trgm so the thresholds can be calibrated
 * offline against the 50 synthetic cases (eval/m20-synthetic-cases.json).
 */

export type PairRelation = "merge" | "conflict" | "keep";

/** Calibrated with `consolidation-calibration.test.ts` — see docs/design/m20c-calibracion.md. */
export const THRESHOLDS = {
  /** Minimum pg_trgm similarity for a pair to be a candidate at all. */
  candidate: 0.3,
  /** A pair whose content tokens are a subset of the other's merges at/above this. */
  mergeSubset: 0.5,
  /** A same-subject pair with a differing value slot is a conflict at/above this. */
  conflict: 0.45,
} as const;
export type Thresholds = { candidate: number; mergeSubset: number; conflict: number };

/** pg_trgm-compatible similarity: words padded with "  " / " ", trigram sets, Jaccard. */
export function trigramSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}
export function trigramSimilarity(a: string, b: string): number {
  const A = trigramSet(a);
  const B = trigramSet(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const STOPWORDS = new Set(
  ("el la los las un una unos unas de del al en y o con como por para a su sus mi mis " +
    "the a an of in on at and or to for with my our its").split(" "),
);
/** Small canonicalization lexicon (number words, inflections, near-synonyms). */
const CANON: Record<string, string> = {
  uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9", diez: "10",
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  será: "es", sera: "es", era: "es", fue: "es", is: "es", will: "es",
  repo: "repositorio", lanzar: "publicar", publish: "publicar", launch: "publicar",
  every: "all", each: "all", todos: "all", todas: "all", cada: "all",
};
/** Verbs/anchors: a shared prefix containing one fixes subject + attribute. */
const ANCHORS = new Set(
  ("es son está están tiene tienen cuesta vale usa usan usamos vive viven trabaja trabajan corre corren " +
    "prefiero prefiere prefieren acordamos decidimos decidió elegimos " +
    "are was has have costs uses lives works runs prefer prefers agreed decided chose :").split(" "),
);

function stem(t: string): string {
  if (/^\d/.test(t) || t.length <= 4) return t;
  return t.replace(/(es|s)$/u, "");
}
export function contentTokens(text: string): string[] {
  const raw = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.\-]*|:/gu) ?? [];
  return raw
    .map((t) => t.replace(/[.\-]+$/u, ""))
    .map((t) => CANON[t] ?? t)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (ANCHORS.has(t) ? t : stem(t)));
}

export interface PairDecision {
  relation: PairRelation;
  similarity: number;
  reason: string;
}

/** Classify two facts of the same user + namespace. `sim` defaults to the JS pg_trgm mirror. */
export function classifyPair(a: string, b: string, t: Thresholds = THRESHOLDS, sim?: number): PairDecision {
  const s = sim ?? trigramSimilarity(a, b);
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  const A = new Set(ta);
  const B = new Set(tb);
  const onlyA = [...A].filter((x) => !B.has(x));
  const onlyB = [...B].filter((x) => !A.has(x));
  if (onlyA.length === 0 && onlyB.length === 0) return { relation: "merge", similarity: s, reason: "same_tokens" };
  if (s < t.candidate) return { relation: "keep", similarity: s, reason: "low_similarity" };
  if ((onlyA.length === 0 || onlyB.length === 0) && s >= t.mergeSubset) {
    return { relation: "merge", similarity: s, reason: "token_subset" };
  }
  // Same subject + attribute: shared ordered prefix that contains an anchor
  // (verb or "key:"), and both sides then disagree on the value slot.
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  const prefix = ta.slice(0, p);
  const anchored = prefix.some((x) => ANCHORS.has(x)) && p >= 2;
  if (anchored && onlyA.length > 0 && onlyB.length > 0 && s >= t.conflict) {
    return { relation: "conflict", similarity: s, reason: "value_slot_differs" };
  }
  return { relation: "keep", similarity: s, reason: anchored ? "below_conflict_threshold" : "different_subject" };
}
