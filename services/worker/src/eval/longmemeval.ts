/**
 * M20d: `pnpm eval:longmemeval [--n 100] [--download]`
 * Downloads LongMemEval-S (MIT, HF xiaowu0162/longmemeval-cleaned) into the
 * gitignored `.cache/longmemeval/` only when `--download` is passed. Never used in CI.
 * Consolidation is evaluated in memory only (dry-run): nothing touches a database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { THRESHOLDS } from "../memory/consolidation-rules.js";
import { bm25Rank, consolidationPairs, evalConsolidation, evalRetrieval, trigramRank, type LmeQuestion } from "./longmemeval-metrics.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIR = resolve(ROOT, ".cache/longmemeval");
const FILE = resolve(DIR, "longmemeval_s_cleaned.json");
const URL_S = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";
const args = process.argv.slice(2);
const n = Number(args[args.indexOf("--n") + 1] ?? 0) || 100;

if (!existsSync(FILE)) {
  if (!args.includes("--download")) {
    console.log(`LongMemEval no encontrado en ${FILE}; omitido (usa --download).`);
    process.exit(0);
  }
  mkdirSync(DIR, { recursive: true });
  console.log("Descargando LongMemEval-S (~277 MB)…");
  const res = await fetch(URL_S);
  if (!res.ok) throw new Error(`descarga falló: ${res.status}`);
  writeFileSync(FILE, Buffer.from(await res.arrayBuffer()));
}

const all: LmeQuestion[] = JSON.parse(readFileSync(FILE, "utf8"));
const pool = all.filter((q) => !q.question_id.endsWith("_abs"));
// Deterministic, stratified-by-position subset: every k-th question.
const step = Math.max(1, Math.floor(pool.length / n));
const subset = pool.filter((_, i) => i % step === 0).slice(0, n);

const pct = (x: number) => (x * 100).toFixed(1) + "%";
const show = (name: string, r: ReturnType<typeof evalRetrieval>) =>
  console.log(`${name.padEnd(8)} n=${r.n} ` + [1, 3, 5, 10].map((k) => `R_any@${k}=${pct(r.recallAny[k]!)} R_all@${k}=${pct(r.recallAll[k]!)}`).join(" ") + ` MRR=${r.mrr.toFixed(3)}`);
console.log(`Subconjunto: ${subset.length} de ${pool.length} preguntas (sin abstención)`);
show("bm25", evalRetrieval(subset, bm25Rank));
show("trigram", evalRetrieval(subset, trigramRank));

const byType = new Map<string, LmeQuestion[]>();
for (const q of subset) byType.set(q.question_type, [...(byType.get(q.question_type) ?? []), q]);
for (const [t, qs] of byType) { const r = evalRetrieval(qs, bm25Rank); console.log(`  bm25 ${t.padEnd(26)} n=${r.n} R_any@5=${pct(r.recallAny[5]!)} MRR=${r.mrr.toFixed(3)}`); }

const pairs = consolidationPairs(subset);
for (const t of [
  { candidate: 0.3, mergeSubset: 0.5, conflict: 0.45 },
  { candidate: 0.3, mergeSubset: 0.6, conflict: 0.45 },
  { candidate: 0.3, mergeSubset: 0.5, conflict: 0.55 },
  { candidate: 0.4, mergeSubset: 0.6, conflict: 0.55 },
]) {
  const r = evalConsolidation(pairs, t);
  console.log(`consolidación ${JSON.stringify(t)} pos=${r.positives} marcados=${pct(r.posFlagged / Math.max(1, r.positives))} (merge ${r.posMerge}, conflict ${r.posConflict}) | neg=${r.negatives} falsos=${pct(r.negFlagged / Math.max(1, r.negatives))} (merge ${r.negMerge}, conflict ${r.negConflict})`);
}
const prf = (r: ReturnType<typeof evalConsolidation>) => {
  const tp = r.posFlagged, fp = r.negFlagged;
  return `recall=${pct(tp / Math.max(1, r.positives))} precision=${pct(tp / Math.max(1, tp + fp))} (tp ${tp}/${r.positives}, fp ${fp}/${r.negatives})`;
};
console.log(`trigramas (THRESHOLDS): ${prf(evalConsolidation(pairs, { ...THRESHOLDS, embedding: undefined }))}`);

// `--embeddings [--model id]`: M20e/M20f local models (downloaded once into
// .cache/models). Thresholds for e5 come from the Spanish set (M20f) and are
// applied here out of sample; LongMemEval's own best-F1 is shown for reference.
if (args.includes("--embeddings")) {
  const { localEmbedder, cosine, EMBEDDING_MODEL } = await import("../memory/embeddings.js");
  const { prAt, sweep } = await import("./multilingual-metrics.js");
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? args[mi + 1]! : EMBEDDING_MODEL;
  const e = await localEmbedder(model, "query");
  const texts = [...new Set([...pairs.pos, ...pairs.neg].flat())];
  const vecs = await e.embed(texts);
  const v = new Map(texts.map((x, i) => [x, vecs[i]!]));
  const cos = (a: string, b: string) => cosine(v.get(a)!, v.get(b)!);
  const grid = model.includes("e5") ? [0.85, 0.875, 0.9, 0.914, 0.93] : [0.45, 0.5, 0.55, 0.6, 0.65];
  console.log(`modelo: ${model}`);
  for (const emb of grid)
    console.log(`trigramas + embeddings ≥${emb}: ${prf(evalConsolidation(pairs, { ...THRESHOLDS, embedding: emb }, cos))}`);
  const scored = [
    ...pairs.pos.map(([a, b]) => ({ label: 1 as const, score: cos(a, b) })),
    ...pairs.neg.map(([a, b]) => ({ label: 0 as const, score: cos(a, b) })),
  ];
  const f = (r: ReturnType<typeof prAt>) => `t=${r.threshold.toFixed(3)} P=${pct(r.precision)} R=${pct(r.recall)} F1=${r.f1.toFixed(3)} (tp ${r.tp}, fp ${r.fp}, fn ${r.fn})`;
  const sw = sweep(scored);
  console.log(`solo coseno, mejor F1 en LME: ${f(sw.bestF1)}`);
  console.log(`solo coseno, 0 FP en LME:     ${f(sw.zeroFp)}`);
  for (const t of grid) console.log(`solo coseno ≥${t}: ${f(prAt(scored, t))}`);
}
console.log("dry-run: no se escribió nada en la base de datos.");
