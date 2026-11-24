/**
 * M20f: `pnpm eval:multilingual [--download]` — validates local multilingual
 * embedding models on Spanish consolidation pairs (eval/m20-multilingual-es-cases.json).
 * Dry-run: in-memory only, no database. Models are fetched into the gitignored
 * `.cache/models/` only with `--download`; never in CI. Production default is
 * unchanged (NOVA_MEMORY_EMBEDDINGS=off, all-MiniLM-L6-v2).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cosine, localEmbedder, type E5Role } from "../memory/embeddings.js";
import { prAt, sweep, type ScoredPair } from "./multilingual-metrics.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(here, "../../eval/m20-multilingual-es-cases.json"), "utf8")) as {
  cases: Array<{ id: string; a: string; b: string; label: 0 | 1; kind: string }>;
};

if (process.env.CI) { console.log("M20f eval omitido en CI."); process.exit(0); }
if (!process.argv.includes("--download") && !existsSync(resolve(ROOT, ".cache/models"))) {
  console.log("Modelos no encontrados en .cache/models; omitido (usa --download).");
  process.exit(0);
}

const configs: Array<{ name: string; model: string; roleA: E5Role; roleB: E5Role }> = [
  { name: "all-MiniLM-L6-v2 (M20e, solo inglés)", model: "Xenova/all-MiniLM-L6-v2", roleA: "query", roleB: "query" },
  { name: "multilingual-e5-small query:/query:", model: "Xenova/multilingual-e5-small", roleA: "query", roleB: "query" },
  { name: "multilingual-e5-small query:/passage:", model: "Xenova/multilingual-e5-small", roleA: "query", roleB: "passage" },
  { name: "paraphrase-multilingual-MiniLM-L12-v2", model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", roleA: "query", roleB: "query" },
];

const pct = (x: number) => (x * 100).toFixed(1) + "%";
const fmt = (r: ReturnType<typeof prAt>) =>
  `t=${r.threshold.toFixed(3)} P=${pct(r.precision)} R=${pct(r.recall)} F1=${r.f1.toFixed(3)} (tp=${r.tp} fp=${r.fp} fn=${r.fn})`;

console.log(`M20f — ${data.cases.length} pares ES (${data.cases.filter((c) => c.label).length} positivos)`);
for (const c of configs) {
  const ea = await localEmbedder(c.model, c.roleA);
  const eb = c.roleA === c.roleB ? ea : await localEmbedder(c.model, c.roleB);
  const va = await ea.embed(data.cases.map((x) => x.a));
  const vb = await eb.embed(data.cases.map((x) => x.b));
  const pairs: ScoredPair[] = data.cases.map((x, i) => ({ label: x.label, score: cosine(va[i]!, vb[i]!) }));
  const { bestF1, zeroFp } = sweep(pairs);
  const byKind = (k: string) => {
    const ps = pairs.filter((_, i) => data.cases[i]!.kind === k);
    return pct(prAt(ps, bestF1.threshold).recall);
  };
  console.log(`\n${c.name}\n  mejor F1:   ${fmt(bestF1)}\n  0 falsos +: ${fmt(zeroFp)}\n  recall@mejorF1 paráfrasis=${byKind("paraphrase")} actualización=${byKind("update")}`);
}
