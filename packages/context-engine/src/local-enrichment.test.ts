import type { ParsedIntent } from "@nova/schema";
import { describe, expect, it } from "vitest";
import {
  localActionCandidates,
  localEnrichmentDraft,
  localEntities,
  localSummary,
  localTags,
} from "./local-enrichment.js";

const researchIntent: ParsedIntent = {
  action_type: "research",
  project_hint: null,
  summary: "Compare this with alternatives",
  priority_guess: "normal",
  confidence: 0.6,
  parser: "heuristic",
  model: null,
};

const base = {
  extractedText: "Acme Analytics Platform. Enterprise plans start at $99 per month. " + "x".repeat(400),
  intentText: "compare this with alternatives",
  intent: researchIntent,
  sourceMeta: {
    url: "https://www.acme-analytics.example.com/pricing",
    title: "Acme Analytics Pricing",
  },
  hasTask: false,
};

describe("local enrichment", () => {
  it("prefers the intent summary and caps at 300 chars", () => {
    expect(localSummary(base)).toBe("Compare this with alternatives");
    const noIntent = { ...base, intent: null };
    const summary = localSummary(noIntent);
    expect(summary).toContain("Acme Analytics Pricing");
    expect(summary.length).toBeLessThanOrEqual(300);
  });

  it("extracts the url host and title topics as entities", () => {
    const entities = localEntities(base);
    expect(entities).toContainEqual({
      kind: "url",
      name: "www.acme-analytics.example.com",
    });
    expect(entities.some((e) => e.kind === "topic")).toBe(true);
  });

  it("derives tags from intent and domain", () => {
    const tags = localTags(base);
    expect(tags).toContain("research");
    expect(tags).toContain("acme-analytics");
  });

  it("proposes a research task only when none exists", () => {
    const candidates = localActionCandidates(base);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      action_type: "nova_task",
      risk_tier: 0,
    });
    expect(localActionCandidates({ ...base, hasTask: true })).toHaveLength(0);
    expect(localActionCandidates({ ...base, intent: null })).toHaveLength(0);
  });

  it("assembles a complete draft with heuristic provenance", () => {
    const draft = localEnrichmentDraft(base);
    expect(draft.provider).toBe("heuristic");
    expect(draft.model).toBeNull();
    expect(draft.priority_signal).toBe("normal");
    expect(draft.summary.length).toBeGreaterThan(0);
  });

  it("handles a bare moment (no intent, no url) without throwing", () => {
    const draft = localEnrichmentDraft({
      extractedText: null,
      intentText: null,
      intent: null,
      sourceMeta: {},
      hasTask: false,
    });
    expect(draft.summary).toBe("Captured context");
    expect(draft.action_candidates).toHaveLength(0);
  });
});
