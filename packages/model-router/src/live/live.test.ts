import type { LiveAnswerRequest } from "@nova/schema";
import { describe, expect, it } from "vitest";
import { buildLiveQaContent } from "./anthropic.js";

const base: LiveAnswerRequest = {
  question: "what are the three bottlenecks?",
  context: {
    url: "https://talks.example.com/scaling",
    title: "Scaling Postgres",
    frames: [
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/png;base64,iVBORw0KGgo=",
    ],
    text_snippets: ["Slide: connections, vacuum, replication lag"],
    recent_qa: [
      { question: "who is speaking?", answer: "A Postgres maintainer.", at: "2026-07-09T10:00:00Z" },
    ],
    session_started_at: "2026-07-09T09:58:00Z",
  },
};

describe("buildLiveQaContent", () => {
  it("converts frames to image blocks with correct media types", () => {
    const blocks = buildLiveQaContent(base);
    const images = blocks.filter((b) => b["type"] === "image");
    expect(images).toHaveLength(2);
    expect((images[0]!["source"] as { media_type: string }).media_type).toBe("image/jpeg");
    expect((images[1]!["source"] as { media_type: string }).media_type).toBe("image/png");
  });

  it("includes metadata, snippets, prior Q&A, and the question in the text block", () => {
    const blocks = buildLiveQaContent(base);
    const text = (blocks.find((b) => b["type"] === "text") as { text: string }).text;
    expect(text).toContain("Scaling Postgres");
    expect(text).toContain("https://talks.example.com/scaling");
    expect(text).toContain("connections, vacuum, replication lag");
    expect(text).toContain("who is speaking?");
    expect(text).toContain("The user's question: what are the three bottlenecks?");
  });

  it("skips malformed frames instead of throwing", () => {
    const blocks = buildLiveQaContent({
      ...base,
      context: { ...base.context, frames: ["data:text/html;base64,PGh0bWw+"] },
    });
    expect(blocks.filter((b) => b["type"] === "image")).toHaveLength(0);
    expect(blocks.filter((b) => b["type"] === "text")).toHaveLength(1);
  });

  it("handles an empty context (the insufficient-context case reaches the model)", () => {
    const blocks = buildLiveQaContent({
      question: "what's the price?",
      context: { frames: [], text_snippets: [], recent_qa: [] },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("The user's question: what's the price?");
  });
});
