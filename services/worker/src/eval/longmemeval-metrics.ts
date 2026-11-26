/**
 * M20d: pure metrics for the local LongMemEval validation (no network, no LLM judge).
 * Retrieval is measured at session level against `answer_session_ids`;
 * consolidation is measured on facts extracted from `has_answer` turns.
 */
import { extractFacts } from "../memory/fact-extractor.js";
import { classifyPair, THRESHOLDS, trigramSimilarity, type Thresholds } from "../memory/consolidation-rules.js";

export interface Turn { role: string; content: string; has_answer?: boolean }
export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
}

const TOKEN = /[\p{L}\p{N}]+/gu;
const STOP = new Set("the a an of in on at and or to for with my i me is are was what how did do you it that this".split(" "));
export function tokens(t: string): string[] {
  return (t.toLowerCase().match(TOKEN) ?? []).filter((w) => !STOP.has(w));
}

/**
 * OR tsquery text for `--pg`, or null when the question has no searchable term.
 * Same rules as the API's memoryQueryTerms after PR #42: only letters/digits (so
 * `& | ! ' :` can never reach to_tsquery), length >= 2, stopwords dropped unless
 * that leaves nothing. On null the caller must not query Postgres: the old
 * `|| "''"` fallback sent to_tsquery('simple', "''") → "syntax error in tsquery".
 */
export function pgTsQuery(question: string): string | null {
  const all = (question.toLowerCase().match(TOKEN) ?? []).filter((w) => w.length > 1);
  const kept = all.filter((w) => !STOP.has(w));
  const terms = [...new Set(kept.length ? kept : all)].slice(0, 32);
  return terms.length ? terms.join(" | ") : null;
}

/** Okapi BM25 over documents (stand-in for the text-first search of M20). */
export function bm25Rank(query: string, docs: string[], k1 = 1.2, b = 0.75): number[] {
  const dt = docs.map(tokens);
  const avg = dt.reduce((s, d) => s + d.length, 0) / Math.max(1, dt.length);
  const df = new Map<string, number>();
  for (const d of dt) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(tokens(query))];
  const scores = dt.map((d) => {
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      if (!f) continue;
      const n = df.get(w)!;
      const idf = Math.log(1 + (dt.length - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return s;
  });
  return order(scores);
}
export function trigramRank(query: string, docs: string[]): number[] {
  return order(docs.map((d) => trigramSimilarity(query, d)));
}
function order(scores: number[]): number[] {
  return scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
}

export const KS = [1, 3, 5, 10] as const;
export interface RetrievalResult { n: number; recallAny: Record<number, number>; recallAll: Record<number, number>; mrr: number }

export function evalRetrieval(qs: LmeQuestion[], rank: (q: string, docs: string[]) => number[]): RetrievalResult {
  const any: Record<number, number> = {}, all: Record<number, number> = {};
  for (const k of KS) { any[k] = 0; all[k] = 0; }
  let mrr = 0, n = 0;
  for (const q of qs) {
    const gold = new Set(q.answer_session_ids);
    if (!gold.size) continue;
    n++;
    const docs = q.haystack_sessions.map((s) => s.filter((t) => t.role === "user").map((t) => t.content).join("\n"));
    const ids = rank(q.question, docs).map((i) => q.haystack_session_ids[i]!);
    const first = ids.findIndex((id) => gold.has(id));
    if (first >= 0) mrr += 1 / (first + 1);
    for (const k of KS) {
      const top = new Set(ids.slice(0, k));
      if ([...gold].some((g) => top.has(g))) any[k]!++;
      if ([...gold].every((g) => top.has(g))) all[k]!++;
    }
  }
  for (const k of KS) { any[k] = any[k]! / Math.max(1, n); all[k] = all[k]! / Math.max(1, n); }
  return { n, recallAny: any, recallAll: all, mrr: mrr / Math.max(1, n) };
}

/**
 * Out-of-sample consolidation check. Positives: pairs of facts extracted from
 * `has_answer` user turns of *different* evidence sessions of a question
 * (same underlying fact, often updated). Negatives: an evidence fact paired
 * with facts from non-evidence sessions of the same haystack (must stay "keep").
 */
export interface ConsolidationResult {
  thresholds: Thresholds;
  positives: number; posFlagged: number; posMerge: number; posConflict: number;
  negatives: number; negFlagged: number; negMerge: number; negConflict: number;
}
export function consolidationPairs(qs: LmeQuestion[], negPerQuestion = 40) {
  const pos: [string, string][] = [], neg: [string, string][] = [];
  for (const q of qs) {
    const gold = new Set(q.answer_session_ids);
    const evid: string[][] = [];
    const other: string[] = [];
    q.haystack_sessions.forEach((s, i) => {
      const id = q.haystack_session_ids[i]!;
      if (gold.has(id)) {
        const f = extractFacts(...s.filter((t) => t.role === "user" && t.has_answer).map((t) => t.content)).map((x) => x.content);
        if (f.length) evid.push(f);
      } else if (other.length < negPerQuestion) {
        for (const x of extractFacts(...s.filter((t) => t.role === "user").map((t) => t.content))) {
          if (other.length < negPerQuestion) other.push(x.content);
        }
      }
    });
    for (let i = 0; i < evid.length; i++) for (let j = i + 1; j < evid.length; j++)
      for (const a of evid[i]!) for (const b of evid[j]!) pos.push([a, b]);
    const anchor = evid.flat()[0];
    if (anchor) for (const o of other) neg.push([anchor, o]);
  }
  return { pos, neg };
}
export function evalConsolidation(
  pairs: ReturnType<typeof consolidationPairs>,
  t: Thresholds = THRESHOLDS,
  cos?: (a: string, b: string) => number | undefined,
): ConsolidationResult {
  const r: ConsolidationResult = { thresholds: t, positives: pairs.pos.length, posFlagged: 0, posMerge: 0, posConflict: 0, negatives: pairs.neg.length, negFlagged: 0, negMerge: 0, negConflict: 0 };
  for (const [a, b] of pairs.pos) {
    const rel = classifyPair(a, b, t, undefined, cos?.(a, b)).relation;
    if (rel === "merge") { r.posMerge++; r.posFlagged++; } else if (rel === "conflict") { r.posConflict++; r.posFlagged++; }
  }
  for (const [a, b] of pairs.neg) {
    const rel = classifyPair(a, b, t, undefined, cos?.(a, b)).relation;
    if (rel === "merge") { r.negMerge++; r.negFlagged++; } else if (rel === "conflict") { r.negConflict++; r.negFlagged++; }
  }
  return r;
}

/** Boolean flags: --download (M20d), --pg (M20, Postgres FTS ranking), --embeddings (M20e, local model). */
const EVAL_FLAGS = new Set(["--download", "--pg", "--embeddings"]);
export interface EvalArgs { n: number; download: boolean; pg: boolean; embeddings: boolean; model?: string }

/** CLI args for `pnpm eval:longmemeval`. Strict: a bad `--n`/`--model` or unknown flag is an error, not a silent default. */
export function parseEvalArgs(argv: string[]): EvalArgs {
  const args = argv.filter((a) => a !== "--");
  let n = 100;
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (EVAL_FLAGS.has(a)) continue;
    // M20g: `--model <id>` picks the local embedding model (only with --embeddings).
    const mm = /^--model(?:=(.*))?$/.exec(a);
    if (mm) {
      const raw = mm[1] ?? args[++i];
      if (!raw || raw.startsWith("--")) throw new Error(`--model necesita un id de modelo (recibido: ${raw ?? "nada"})`);
      model = raw;
      continue;
    }
    const m = /^--n(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`argumento desconocido: ${a} (uso: [--n 100] [--download] [--pg] [--embeddings [--model id]])`);
    const raw = m[1] ?? args[++i];
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1) throw new Error(`--n debe ser un entero >= 1 (recibido: ${raw ?? "nada"})`);
    n = v;
  }
  const embeddings = args.includes("--embeddings");
  if (model !== undefined && !embeddings) throw new Error("--model solo tiene sentido con --embeddings");
  return { n, download: args.includes("--download"), pg: args.includes("--pg"), embeddings, ...(model !== undefined ? { model } : {}) };
}

/** Deterministic subset without abstention questions: every k-th question, at most n. */
export function selectSubset(all: LmeQuestion[], n: number): { subset: LmeQuestion[]; pool: number } {
  const pool = all.filter((q) => !q.question_id.endsWith("_abs"));
  const step = Math.max(1, Math.floor(pool.length / n));
  return { subset: pool.filter((_, i) => i % step === 0).slice(0, n), pool: pool.length };
}
