import type { AudioInput, TranscriptionProvider } from "../types.js";

/**
 * OpenAI Whisper transcription. Privacy contract (docs/CONTEXT_BUFFER.md,
 * SECURITY_PRIVACY_GOVERNANCE.md): audio is held in memory only, forwarded
 * once to the provider, and never written to disk or database by Nova. Using
 * a cloud ASR provider is disclosed in the extension UI next to the mic.
 */
export interface OpenAITranscriberOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAITranscriber implements TranscriptionProvider {
  readonly name = "openai-whisper";
  private readonly options: Required<OpenAITranscriberOptions>;

  constructor(options: OpenAITranscriberOptions) {
    this.options = {
      model: "whisper-1",
      baseUrl: "https://api.openai.com/v1",
      timeoutMs: 30_000,
      ...options,
    };
  }

  async transcribe(audio: AudioInput): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
      audio.filename,
    );
    form.append("model", this.options.model);

    const res = await fetch(`${this.options.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Whisper API ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { text?: string };
    if (typeof body.text !== "string") {
      throw new Error("Whisper API returned no transcript text");
    }
    return body.text.trim();
  }
}
