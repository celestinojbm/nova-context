-- M20 (BM25-style search): Postgres full-text search over memory_items.
-- 'simple' config = language-agnostic (Spanish + English), no stemming surprises.
-- Forward-only, additive. Trigram index from 0015 stays as the fallback.
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_memory_items_tsv ON memory_items USING gin (tsv);
