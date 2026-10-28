/** M20f: pure precision/recall helpers for embedding-pair evaluation. */
export interface ScoredPair { label: 0 | 1; score: number }
export interface PR { threshold: number; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }

export function prAt(pairs: ScoredPair[], threshold: number): PR {
  let tp = 0, fp = 0, fn = 0;
  for (const p of pairs) {
    const hit = p.score >= threshold;
    if (hit && p.label === 1) tp++;
    else if (hit) fp++;
    else if (p.label === 1) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { threshold, tp, fp, fn, precision, recall, f1 };
}

/** Best-F1 threshold, and the lowest threshold with zero false positives. */
export function sweep(pairs: ScoredPair[]): { bestF1: PR; zeroFp: PR } {
  const ts = [...new Set(pairs.map((p) => Math.round(p.score * 1000) / 1000))].sort((a, b) => a - b);
  let bestF1 = prAt(pairs, 1.01);
  let zeroFp = prAt(pairs, 1.01);
  for (const t of ts) {
    const r = prAt(pairs, t);
    if (r.f1 > bestF1.f1) bestF1 = r;
    if (r.fp === 0 && r.recall > zeroFp.recall) zeroFp = r;
  }
  return { bestF1, zeroFp };
}
