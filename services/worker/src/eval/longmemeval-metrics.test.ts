import { describe, expect, it } from "vitest";
import {
  bm25Rank, consolidationPairs, evalConsolidation, evalRetrieval, parseEvalArgs, selectSubset, type LmeQuestion,
} from "./longmemeval-metrics.js";

const q: LmeQuestion = {
  question_id: "t1", question_type: "single-session-user", question: "What color is my bike?",
  answer_session_ids: ["s2"], haystack_session_ids: ["s1", "s2", "s3"],
  haystack_sessions: [
    [{ role: "user", content: "I like pasta." }],
    [{ role: "user", content: "My bike is red.", has_answer: true }],
    [{ role: "user", content: "The weather is nice." }],
  ],
};
describe("M20d LongMemEval metrics (fixture; real dataset is never fetched in CI)", () => {
  it("bm25 ranks the evidence session first", () => {
    expect(bm25Rank("bike color", ["pasta", "my bike is red", "weather"])[0]).toBe(1);
    const r = evalRetrieval([q], bm25Rank);
    expect(r.recallAny[1]).toBe(1);
    expect(r.mrr).toBe(1);
  });

  it("recall_all needs every evidence session in top-k; recall_any only one; MRR uses the first hit", () => {
    const multi: LmeQuestion = {
      ...q, question_id: "t2", answer_session_ids: ["s1", "s3"],
      haystack_session_ids: ["s1", "s2", "s3"],
      haystack_sessions: [[{ role: "user", content: "a" }], [{ role: "user", content: "b" }], [{ role: "user", content: "c" }]],
    };
    const fixed = () => [1, 0, 2]; // s2, s1, s3
    const r = evalRetrieval([multi], fixed);
    expect(r.recallAny).toMatchObject({ 1: 0, 3: 1 });
    expect(r.recallAll).toMatchObject({ 1: 0, 3: 1 });
    expect(evalRetrieval([multi], () => [0, 1, 2]).recallAll[1]).toBe(0);
    expect(r.mrr).toBe(0.5);
  });

  it("questions without evidence sessions are excluded from n", () => {
    expect(evalRetrieval([{ ...q, answer_session_ids: [] }], bm25Rank).n).toBe(0);
  });

  it("consolidation pairs: positives across evidence sessions, negatives vs non-evidence; dry-run counts", () => {
    const c: LmeQuestion = {
      question_id: "c1", question_type: "knowledge-update", question: "¿Qué base de datos usa Dona?",
      answer_session_ids: ["e1", "e2"], haystack_session_ids: ["e1", "x1", "e2"],
      haystack_sessions: [
        [{ role: "user", content: "Dona usa Postgres como base de datos.", has_answer: true }],
        [{ role: "user", content: "Nova vive en Madrid." }],
        [{ role: "user", content: "Dona usa MySQL como base de datos.", has_answer: true },
         { role: "user", content: "Nova vive en Lisboa." }], // no has_answer → not a positive
      ],
    };
    const pairs = consolidationPairs([c]);
    expect(pairs.pos).toEqual([["Dona usa Postgres como base de datos", "Dona usa MySQL como base de datos"]]);
    expect(pairs.neg).toEqual([["Dona usa Postgres como base de datos", "Nova vive en Madrid"]]);
    const r = evalConsolidation(pairs);
    expect(r).toMatchObject({ positives: 1, posFlagged: 1, posConflict: 1, negatives: 1, negFlagged: 0 });
  });

  it("negatives per question are capped", () => {
    const many: LmeQuestion = {
      ...q, question_id: "c2", answer_session_ids: ["e"], haystack_session_ids: ["e", ...Array.from({ length: 10 }, (_, i) => `o${i}`)],
      haystack_sessions: [
        [{ role: "user", content: "Dona usa Postgres como base de datos.", has_answer: true }],
        ...Array.from({ length: 10 }, (_, i) => [{ role: "user", content: `Proyecto${i} vive en Ciudad${i}.` }]),
      ],
    };
    expect(consolidationPairs([many], 3).neg).toHaveLength(3);
  });
});

describe("M20d eval CLI helpers", () => {
  it("parses --n strictly and ignores pnpm's '--'", () => {
    const off = { pg: false, embeddings: false };
    expect(parseEvalArgs([])).toEqual({ n: 100, download: false, ...off });
    expect(parseEvalArgs(["--", "--n", "20", "--download"])).toEqual({ n: 20, download: true, ...off });
    expect(parseEvalArgs(["--n=7"])).toEqual({ n: 7, download: false, ...off });
    expect(parseEvalArgs(["--download"])).toEqual({ n: 100, download: true, ...off }); // was: args[0] read as --n
    // M20 (--pg) and M20e (--embeddings) flags: accepted, not mistaken for --n's value.
    expect(parseEvalArgs(["--pg", "--embeddings", "--n", "5"])).toEqual({ n: 5, download: false, pg: true, embeddings: true });
    expect(() => parseEvalArgs(["--n", "--pg"])).toThrow(/entero/);
    expect(() => parseEvalArgs(["--n", "abc"])).toThrow(/entero/);
    expect(() => parseEvalArgs(["--n"])).toThrow(/entero/);
    expect(() => parseEvalArgs(["--n", "0"])).toThrow(/entero/);
    expect(() => parseEvalArgs(["--nn"])).toThrow(/desconocido/);
  });

  it("subset is deterministic, excludes abstention and respects n", () => {
    const all = Array.from({ length: 50 }, (_, i) => ({ ...q, question_id: i % 10 === 9 ? `q${i}_abs` : `q${i}` }));
    const a = selectSubset(all, 10);
    expect(a.pool).toBe(45);
    expect(a.subset).toHaveLength(10);
    expect(a.subset.every((x) => !x.question_id.endsWith("_abs"))).toBe(true);
    expect(selectSubset(all, 10).subset.map((x) => x.question_id)).toEqual(a.subset.map((x) => x.question_id));
    expect(selectSubset(all, 1000).subset).toHaveLength(45);
  });
});
