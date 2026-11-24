/**
 * M20e: local embeddings for consolidation candidates. Free, on-device model
 * (Xenova/all-MiniLM-L6-v2, 384 dims, int8 ONNX via transformers.js, Apache-2.0);
 * no API, no spend. The model is fetched once into `.cache/models/` only when
 * explicitly enabled (NOVA_MEMORY_EMBEDDINGS=local); CI never loads it — tests
 * inject a fake `Embedder`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const CACHE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.cache/models",
);

/** e5 role prefix: "query" (symmetric, M20e default) or "passage". */
export type E5Role = "query" | "passage";

/** e5 models require "query: " / "passage: " prefixes; other models get raw text. */
export function prefixFor(model: string, texts: string[], role: E5Role = "query"): string[] {
  return model.includes("e5") ? texts.map((x) => `${role}: ${x}`) : texts;
}

export async function localEmbedder(
  model = EMBEDDING_MODEL,
  role: E5Role = "query",
): Promise<Embedder> {
  if (process.env.CI)
    throw new Error("local embeddings are disabled in CI (model download)");
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE;
  const fe = await pipeline("feature-extraction", model, { dtype: "q8" });
  return {
    model,
    dim: EMBEDDING_DIM,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 32) {
        // e5 expects a prefix; "query: " is the symmetric-similarity form.
        const t = await fe(
          prefixFor(model, texts.slice(i, i + 32), role),
          { pooling: "mean", normalize: true },
        );
        const data = t.data as Float32Array;
        for (let j = 0; j < t.dims[0]!; j++)
          out.push(data.slice(j * EMBEDDING_DIM, (j + 1) * EMBEDDING_DIM));
      }
      return out;
    },
  };
}

/** Cosine of two L2-normalised vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
