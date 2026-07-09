import {
  TranscriptionUnavailableError,
  type AudioInput,
  type TranscriptionProvider,
} from "../types.js";

export interface TranscriptionResult {
  transcript: string;
  provider: string;
}

/**
 * Fallback chain for transcription. Unlike intent parsing there is no
 * offline terminal fallback — when no provider is configured the router
 * reports TranscriptionUnavailableError and clients degrade to typed input
 * (typed input is equal-class by design; see docs/BUILD_PLAN.md §9).
 */
export class TranscriptionRouter {
  constructor(private readonly chain: TranscriptionProvider[] = []) {}

  get available(): boolean {
    return this.chain.length > 0;
  }

  async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    if (!this.chain.length) {
      throw new TranscriptionUnavailableError();
    }
    const failures: string[] = [];
    for (const provider of this.chain) {
      try {
        const transcript = await provider.transcribe(audio);
        return { transcript, provider: provider.name };
      } catch (err) {
        failures.push(`${provider.name}: ${(err as Error).message}`);
      }
    }
    throw new Error(`All transcription providers failed — ${failures.join("; ")}`);
  }
}
