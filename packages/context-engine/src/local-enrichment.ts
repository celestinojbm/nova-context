import type {
  ActionCandidate,
  EnrichedEntity,
  EnrichmentDraft,
  ParsedIntent,
} from "@nova/schema";

/**
 * Local (heuristic) enrichment — the degradation path when no cloud provider
 * is configured or the LLM call fails. Pure functions, no network, no keys.
 * The output is deliberately modest but keeps every moment usable: a cleaned
 * extract-based summary, cheap entities, tags, and conservative action
 * candidates derived from the parsed intent.
 */

export interface LocalEnrichmentInput {
  extractedText: string | null;
  intentText: string | null;
  intent: ParsedIntent | null;
  sourceMeta: Record<string, unknown>;
  hasTask: boolean;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function localSummary(input: LocalEnrichmentInput): string {
  const title = clean(String(input.sourceMeta["title"] ?? ""));
  const body = clean(input.extractedText ?? "");
  // Prefer the intent's own summary when present — it is what the user said
  // mattered — then title + leading body text.
  if (input.intent?.summary && input.intent.summary !== "Captured context") {
    return input.intent.summary.slice(0, 300);
  }
  const lead = body.slice(0, 240);
  const combined = [title, lead].filter(Boolean).join(" — ");
  return (combined || "Captured context").slice(0, 300);
}

export function localEntities(input: LocalEnrichmentInput): EnrichedEntity[] {
  const entities: EnrichedEntity[] = [];
  const url = input.sourceMeta["url"];
  if (typeof url === "string") {
    try {
      entities.push({ kind: "url", name: new URL(url).host });
    } catch {
      /* unparseable url — skip */
    }
  }
  const title = String(input.sourceMeta["title"] ?? "");
  // Capitalized multiword sequences in the title are a cheap topic signal.
  const topicMatches = title.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\b/g) ?? [];
  for (const topic of topicMatches.slice(0, 3)) {
    entities.push({ kind: "topic", name: topic });
  }
  return entities;
}

export function localTags(input: LocalEnrichmentInput): string[] {
  const tags = new Set<string>();
  if (input.intent) tags.add(input.intent.action_type.replace(/_/g, "-"));
  const url = input.sourceMeta["url"];
  if (typeof url === "string") {
    try {
      const host = new URL(url).host.replace(/^www\./, "");
      tags.add(host.split(".")[0] ?? host);
    } catch {
      /* skip */
    }
  }
  if (input.intent?.priority_guess === "high") tags.add("urgent");
  return [...tags].slice(0, 12);
}

export function localActionCandidates(
  input: LocalEnrichmentInput,
): ActionCandidate[] {
  // Conservative by design: heuristics only propose when the intent clearly
  // implies follow-on work the capture didn't already execute.
  if (!input.intent) return [];
  if (input.intent.action_type === "research" && !input.hasTask) {
    return [
      {
        action_type: "nova_task",
        title: `Research: ${input.intent.summary}`.slice(0, 512),
        detail: input.intentText,
        risk_tier: 0,
      },
    ];
  }
  return [];
}

export function localEnrichmentDraft(input: LocalEnrichmentInput): EnrichmentDraft {
  return {
    summary: localSummary(input),
    entities: localEntities(input),
    tags: localTags(input),
    action_candidates: localActionCandidates(input),
    priority_signal: input.intent?.priority_guess ?? "normal",
    refined_action_type: null,
    provider: "heuristic",
    model: null,
  };
}
