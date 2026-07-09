import type { ParsedIntent } from "@nova/schema";
import type { IntentParseInput, IntentProvider } from "../types.js";

/**
 * Deterministic rule-based intent parser. This is the terminal fallback in
 * the intent chain: no API key, no network, no failure mode. Quality ceiling
 * is deliberately modest — the LLM parser refines when configured.
 */

const TASK_PATTERNS =
  /\b(create (a )?task|add (a )?task|make (a )?task|to[- ]?do|todo|checklist|draft (a )?task)\b/i;
const FOLLOW_UP_PATTERNS =
  /\b(remind me|follow[- ]?up|check back|circle back|reminder|later this week|next week|tomorrow)\b/i;
const RESEARCH_PATTERNS =
  /\b(research|compare|find out|investigate|look into|analy[sz]e|evaluate|dig into)\b/i;
const SAVE_PATTERNS =
  /\b(remember|save|keep|bookmark|store|preserve|capture|add) (this|it|that|the)?\b/i;

const HIGH_PRIORITY = /\b(urgent|asap|immediately|critical|important|high priority|right away)\b/i;
const LOW_PRIORITY = /\b(low priority|whenever|no rush|someday|eventually|not urgent)\b/i;

// "for/to/in/into (the|my) <name> project" or "project <name>". The greedy
// [\s\S]* prefix anchors the match to the LAST preposition before "project",
// so "a task to review this for the pricing project" yields "pricing".
const PROJECT_HINT_PATTERNS: RegExp[] = [
  /^[\s\S]*\b(?:for|to|in|into|under|on)\s+(?:the\s+|my\s+)?([\w][\w &'-]{0,60}?)\s+project\b/i,
  /\bproject\s+(?:called\s+|named\s+)?["']?([\w][\w &'-]{0,60}?)["']?(?:[.,;!]|$)/i,
];

export function extractProjectHint(text: string): string | null {
  for (const pattern of PROJECT_HINT_PATTERNS) {
    const match = pattern.exec(text);
    const hint = match?.[1]?.trim();
    if (hint) return hint;
  }
  return null;
}

function summarize(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Captured context";
  const firstSentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137)}...`
    : firstSentence;
}

export class HeuristicIntentParser implements IntentProvider {
  readonly name = "heuristic";

  parseIntent(input: IntentParseInput): Promise<ParsedIntent> {
    const text = input.text.trim();

    let actionType: ParsedIntent["action_type"] = "unknown";
    let confidence = 0.3;
    if (TASK_PATTERNS.test(text)) {
      actionType = "create_task";
      confidence = 0.8;
    } else if (FOLLOW_UP_PATTERNS.test(text)) {
      actionType = "remind_follow_up";
      confidence = 0.7;
    } else if (RESEARCH_PATTERNS.test(text)) {
      actionType = "research";
      confidence = 0.6;
    } else if (SAVE_PATTERNS.test(text)) {
      actionType = "save_reference";
      confidence = 0.6;
    } else if (text.length > 0) {
      // A non-empty instruction with no recognized verb still means the user
      // chose to keep this context.
      actionType = "save_reference";
      confidence = 0.4;
    }

    const priority: ParsedIntent["priority_guess"] = HIGH_PRIORITY.test(text)
      ? "high"
      : LOW_PRIORITY.test(text)
        ? "low"
        : "normal";

    return Promise.resolve({
      action_type: actionType,
      project_hint: extractProjectHint(text),
      summary: summarize(text),
      priority_guess: priority,
      confidence,
      parser: "heuristic",
      model: null,
    });
  }
}
