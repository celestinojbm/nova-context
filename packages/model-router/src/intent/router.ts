import type { ParsedIntent } from "@nova/schema";
import { HeuristicIntentParser } from "./heuristic.js";
import type { IntentParseInput, IntentProvider } from "../types.js";

export interface IntentParseResult {
  intent: ParsedIntent;
  provider: string;
  // Providers that were tried and failed before one succeeded.
  failures: Array<{ provider: string; error: string }>;
}

/**
 * Fallback chain for intent parsing. Providers are tried in order; the
 * heuristic parser is always appended as the terminal member, so parse()
 * never rejects — a capture must not fail because a model provider is down.
 */
export class IntentRouter {
  private readonly chain: IntentProvider[];

  constructor(providers: IntentProvider[] = []) {
    const heuristic = new HeuristicIntentParser();
    this.chain = [
      ...providers.filter((p) => p.name !== heuristic.name),
      heuristic,
    ];
  }

  get providers(): string[] {
    return this.chain.map((p) => p.name);
  }

  async parse(input: IntentParseInput): Promise<IntentParseResult> {
    const failures: Array<{ provider: string; error: string }> = [];
    for (const provider of this.chain) {
      try {
        const intent = await provider.parseIntent(input);
        return { intent, provider: provider.name, failures };
      } catch (err) {
        failures.push({
          provider: provider.name,
          error: (err as Error).message,
        });
      }
    }
    // Unreachable: the heuristic provider does not throw. Kept as a guard.
    throw new Error(
      `All intent providers failed: ${failures.map((f) => f.provider).join(", ")}`,
    );
  }
}
