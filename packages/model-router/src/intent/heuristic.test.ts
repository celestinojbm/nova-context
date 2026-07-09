import { describe, expect, it } from "vitest";
import { HeuristicIntentParser, extractProjectHint } from "./heuristic.js";

const parser = new HeuristicIntentParser();

/**
 * Golden fixtures (docs/BUILD_PLAN.md §7): transcripts → expected structured
 * intents, regression-locked. Extend this corpus as real transcripts arrive.
 */
const GOLDEN: Array<{
  text: string;
  action_type: string;
  project_hint: string | null;
  priority_guess: string;
}> = [
  {
    text: "Create a task to follow up with Acme about their API limits, this is for the Acme project",
    action_type: "create_task",
    project_hint: "Acme",
    priority_guess: "normal",
  },
  {
    text: "remember this for the pricing project",
    action_type: "save_reference",
    project_hint: "pricing",
    priority_guess: "normal",
  },
  {
    text: "Remind me to check back on this next week",
    action_type: "remind_follow_up",
    project_hint: null,
    priority_guess: "normal",
  },
  {
    text: "Compare this with alternatives and save the best options",
    action_type: "research",
    project_hint: null,
    priority_guess: "normal",
  },
  {
    text: "add a task to review this ASAP, it's urgent",
    action_type: "create_task",
    project_hint: null,
    priority_guess: "high",
  },
  {
    text: "save this somewhere, no rush",
    action_type: "save_reference",
    project_hint: null,
    priority_guess: "low",
  },
  {
    text: "this looks interesting",
    action_type: "save_reference",
    project_hint: null,
    priority_guess: "normal",
  },
];

describe("HeuristicIntentParser (golden fixtures)", () => {
  for (const fixture of GOLDEN) {
    it(`parses: "${fixture.text.slice(0, 50)}..."`, async () => {
      const intent = await parser.parseIntent({ text: fixture.text });
      expect(intent.action_type).toBe(fixture.action_type);
      expect(intent.project_hint).toBe(fixture.project_hint);
      expect(intent.priority_guess).toBe(fixture.priority_guess);
      expect(intent.parser).toBe("heuristic");
      expect(intent.model).toBeNull();
      expect(intent.confidence).toBeGreaterThan(0);
      expect(intent.confidence).toBeLessThanOrEqual(1);
      expect(intent.summary.length).toBeGreaterThan(0);
      expect(intent.summary.length).toBeLessThanOrEqual(140);
    });
  }

  it("produces a usable summary from a long rambling transcript", async () => {
    const intent = await parser.parseIntent({
      text: "so um I was thinking this page has a really good breakdown of the enterprise pricing tiers and we should definitely keep it around because when we do our own pricing next month it will be useful to compare against ".repeat(3),
    });
    expect(intent.summary.length).toBeLessThanOrEqual(140);
  });

  it("handles empty text without throwing", async () => {
    const intent = await parser.parseIntent({ text: "" });
    expect(intent.action_type).toBe("unknown");
    expect(intent.summary).toBe("Captured context");
  });
});

describe("extractProjectHint", () => {
  it.each([
    ["save this for the pricing project", "pricing"],
    ["add it to my Marketing Q3 project", "Marketing Q3"],
    ["file under the nova-context project please", "nova-context"],
    ["put this in project Atlas.", "Atlas"],
    ["just save this", null],
  ])("%s -> %s", (text, expected) => {
    expect(extractProjectHint(text)).toBe(expected);
  });
});
