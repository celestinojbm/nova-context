-- M20e: local embeddings for consolidation candidates (docs/design/memoria-m20.md).
-- 384 dims (all-MiniLM-L6-v2) ≠ the 1536-dim `embeddings` table, so a separate
-- table keyed by (memory_item_id, model). Forward-only, additive. Numbered 0017
-- so it does not collide with 0016 (memory FTS, sibling PR).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  model          text NOT NULL,
  embedding      vector(384) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, model)
);
CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_hnsw
  ON memory_item_embeddings USING hnsw (embedding vector_cosine_ops);
