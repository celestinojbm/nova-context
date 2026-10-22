/**
 * M20d: `pnpm eval:longmemeval [--n 100] [--download]`
 * Downloads LongMemEval-S (MIT, HF xiaowu0162/longmemeval-cleaned) into the
 * gitignored `.cache/longmemeval/` only when `--download` is passed. Never used in CI.
 * Consolidation is evaluated in memory only (dry-run): nothing touches a database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  tokens,
  bm25Rank,
  consolidationPairs,
  evalConsolidation,
  evalRetrieval,
  trigramRank,
  type LmeQuestion,
} from "./longmemeval-metrics.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIR = resolve(ROOT, ".cache/longmemeval");
const FILE = resolve(DIR, "longmemeval_s_cleaned.json");
const URL_S =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";
const args = process.argv.slice(2);
const n = Number(args[args.indexOf("--n") + 1] ?? 0) || 100;

if (!existsSync(FILE)) {
  if (!args.includes("--download")) {
    console.log(
      `LongMemEval no encontrado en ${FILE}; omitido (usa --download).`,
    );
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
  console.log(
    `${name.padEnd(8)} n=${r.n} ` +
      [1, 3, 5, 10]
        .map(
          (k) =>
            `R_any@${k}=${pct(r.recallAny[k]!)} R_all@${k}=${pct(r.recallAll[k]!)}`,
        )
        .join(" ") +
      ` MRR=${r.mrr.toFixed(3)}`,
  );
console.log(
  `Subconjunto: ${subset.length} de ${pool.length} preguntas (sin abstención)`,
);
show("bm25", evalRetrieval(subset, bm25Rank));
show("trigram", evalRetrieval(subset, trigramRank));

// `--pg`: same ranking SQL as GET /memory?q= (tsvector 'simple' + ts_rank(·,1),
// OR-query over tokens, trigram as tie-break). Uses a TEMP table only.
if (args.includes("--pg")) {
  const pg = (await import("pg")).default;
  const c = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://nova:nova@localhost:5432/nova",
  });
  await c.connect();
  await c.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const CFG = process.env.LME_CFG ?? "simple",
    FN = process.env.LME_FN ?? "ts_rank",
    NORM = process.env.LME_NORM ?? "1";
  await c.query(
    `CREATE TEMP TABLE lme_docs (i int, content text, tsv tsvector GENERATED ALWAYS AS (to_tsvector('${CFG}', content)) STORED)`,
  );
  const cache = new Map<string, number[]>();
  for (const q of subset) {
    const docs = q.haystack_sessions.map((s) =>
      s
        .filter((t) => t.role === "user")
        .map((t) => t.content)
        .join("\n"),
    );
    await c.query("TRUNCATE lme_docs");
    await c.query(
      "INSERT INTO lme_docs SELECT i - 1, d FROM unnest($1::text[]) WITH ORDINALITY AS u(d, i)",
      [docs],
    );
    const terms = [
      ...new Set(tokens(q.question).filter((w) => w.length > 1)),
    ].slice(0, 32);
    const { rows } = await c.query<{ i: number }>(
      `SELECT i FROM lme_docs ORDER BY ${FN}(tsv, to_tsquery('${CFG}', $1), ${NORM}) DESC, word_similarity($2, content) DESC, i`,
      [terms.join(" | ") || "''", q.question],
    );
    cache.set(
      q.question_id,
      rows.map((r) => r.i),
    );
  }
  await c.end();
  const byQ = new Map(subset.map((q) => [q.question, q.question_id]));
  show(
    "pg_fts",
    evalRetrieval(subset, (question) => cache.get(byQ.get(question)!)!),
  );
}

const byType = new Map<string, LmeQuestion[]>();
for (const q of subset)
  byType.set(q.question_type, [...(byType.get(q.question_type) ?? []), q]);
for (const [t, qs] of byType) {
  const r = evalRetrieval(qs, bm25Rank);
  console.log(
    `  bm25 ${t.padEnd(26)} n=${r.n} R_any@5=${pct(r.recallAny[5]!)} MRR=${r.mrr.toFixed(3)}`,
  );
}

const pairs = consolidationPairs(subset);
for (const t of [
  { candidate: 0.3, mergeSubset: 0.5, conflict: 0.45 },
  { candidate: 0.3, mergeSubset: 0.6, conflict: 0.45 },
  { candidate: 0.3, mergeSubset: 0.5, conflict: 0.55 },
  { candidate: 0.4, mergeSubset: 0.6, conflict: 0.55 },
]) {
  const r = evalConsolidation(pairs, t);
  console.log(
    `consolidación ${JSON.stringify(t)} pos=${r.positives} marcados=${pct(r.posFlagged / Math.max(1, r.positives))} (merge ${r.posMerge}, conflict ${r.posConflict}) | neg=${r.negatives} falsos=${pct(r.negFlagged / Math.max(1, r.negatives))} (merge ${r.negMerge}, conflict ${r.negConflict})`,
  );
}
console.log("dry-run: no se escribió nada en la base de datos.");
