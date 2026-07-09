import type { ParsedIntent } from "@nova/schema";

/**
 * Provider-agnostic model routing (v0, per docs/INTELLIGENCE_ENGINE.md).
 * Two task types exist in M1: intent parsing and transcription. Each has a
 * provider chain with fallback-on-error; the intent chain always ends with
 * the deterministic heuristic parser, so intent parsing can never fail.
 */

export interface IntentParseInput {
  text: string;
  // Optional context that helps the parser (page title, project names).
  pageTitle?: string | null;
  knownProjects?: string[];
}

export interface IntentProvider {
  readonly name: string;
  parseIntent(input: IntentParseInput): Promise<ParsedIntent>;
}

export interface AudioInput {
  data: Buffer;
  mimeType: string;
  filename: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: AudioInput): Promise<string>;
}

export class TranscriptionUnavailableError extends Error {
  constructor(message = "No transcription provider is configured") {
    super(message);
    this.name = "TranscriptionUnavailableError";
  }
}
