export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

/**
 * OpenAI text-embedding-3-small — 1536 dimensions, matching the pgvector
 * column in the schema (BUILD_PLAN §4). Input is truncated to a safe size;
 * embedding whole documents is deferred to chunking in a later milestone.
 */
export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions = 1536;
  private readonly options: Required<OpenAIEmbedderOptions>;

  constructor(options: OpenAIEmbedderOptions) {
    this.options = {
      model: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1",
      timeoutMs: 15_000,
      ...options,
    };
    this.model = this.options.model;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.options.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        input: text.slice(0, 24_000),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Embeddings API ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = body.data?.[0]?.embedding;
    if (!embedding || embedding.length !== this.dimensions) {
      throw new Error("Embeddings API returned an unexpected vector");
    }
    return embedding;
  }
}
