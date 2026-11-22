/**
 * M20d: `pnpm eval:longmemeval [--n 100] [--download]`
 * Downloads LongMemEval-S (MIT, HF xiaowu0162/longmemeval-cleaned) into the
 * gitignored `.cache/longmemeval/` only when `--download` is passed. Never used in CI.
 * The download is pinned to one dataset revision and verified by sha256, and
 * written atomically (.part → rename), so results in docs/design/m20d-evaluacion.md
 * are reproducible and a cut-off download never leaves a corrupt cache file.
 * Consolidation is evaluated in memory only (dry-run): nothing touches a database.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { THRESHOLDS } from "../memory/consolidation-rules.js";
import {
  bm25Rank, consolidationPairs, evalConsolidation, evalRetrieval, parseEvalArgs, selectSubset, trigramRank, type LmeQuestion,
} from "./longmemeval-metrics.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIR = resolve(ROOT, ".cache/longmemeval");
const FILE = resolve(DIR, "longmemeval_s_cleaned.json");
/** Dataset revision and LFS sha256 the published results were computed on. */
const REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f";
const SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
const URL_S = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${REVISION}/longmemeval_s_cleaned.json`;

let opts: ReturnType<typeof parseEvalArgs>;
try {
  opts = parseEvalArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const { n } = opts;

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest("hex");
}

if (!existsSync(FILE)) {
  if (!opts.download) {
    console.log(`LongMemEval no encontrado en ${FILE}; omitido (usa --download).`);
    process.exit(0);
  }
  mkdirSync(DIR, { recursive: true });
  console.log(`Descargando LongMemEval-S (~277 MB, revisión ${REVISION.slice(0, 7)})…`);
  const res = await fetch(URL_S);
  if (!res.ok || !res.body) throw new Error(`descarga falló: ${res.status}`);
  const part = `${FILE}.part`;
  const h = createHash("sha256");
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      new Transform({ transform(c, _e, cb) { h.update(c); cb(null, c); } }),
      createWriteStream(part),
    );
    const got = h.digest("hex");
    if (got !== SHA256) throw new Error(`sha256 no coincide: esperado ${SHA256}, obtenido ${got}`);
    renameSync(part, FILE);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
} else if ((await sha256Of(FILE)) !== SHA256) {
  console.error(`${FILE} no es la revisión ${REVISION.slice(0, 7)} (sha256 distinto). Bórralo y usa --download.`);
  process.exit(1);
}

const all: LmeQuestion[] = JSON.parse(readFileSync(FILE, "utf8"));
const { subset, pool } = selectSubset(all, n);

const pct = (x: number) => (x * 100).toFixed(1) + "%";
const show = (name: string, r: ReturnType<typeof evalRetrieval>) =>
  console.log(`${name.padEnd(8)} n=${r.n} ` + [1, 3, 5, 10].map((k) => `R_any@${k}=${pct(r.recallAny[k]!)} R_all@${k}=${pct(r.recallAll[k]!)}`).join(" ") + ` MRR=${r.mrr.toFixed(3)}`);
console.log(`Subconjunto: ${subset.length} de ${pool} preguntas (sin abstención)`);
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

// `--embeddings`: M20e, local all-MiniLM-L6-v2 (downloaded once into .cache/models).
if (opts.embeddings) {
  const { localEmbedder, cosine } = await import("../memory/embeddings.js");
  const e = await localEmbedder();
  const texts = [...new Set([...pairs.pos, ...pairs.neg].flat())];
  const vecs = await e.embed(texts);
  const v = new Map(texts.map((x, i) => [x, vecs[i]!]));
  const cos = (a: string, b: string) => cosine(v.get(a)!, v.get(b)!);
  for (const emb of [0.45, 0.5, 0.55, 0.6, 0.65])
    console.log(`trigramas + embeddings ≥${emb}: ${prf(evalConsolidation(pairs, { ...THRESHOLDS, embedding: emb }, cos))}`);
}
console.log("dry-run: no se escribió nada en la base de datos.");
