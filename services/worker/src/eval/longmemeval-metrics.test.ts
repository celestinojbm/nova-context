import { describe, expect, it } from "vitest";
import { bm25Rank, evalRetrieval, type LmeQuestion } from "./longmemeval-metrics.js";

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
});
