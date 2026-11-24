-- M20e: local embeddings for consolidation candidates (docs/design/m20e-embeddings.md).
-- 384 dims (all-MiniLM-L6-v2) ≠ the 1536-dim `embeddings` table, so a separate
-- table keyed by (memory_item_id, model). Forward-only, additive. Numbered 0017
-- so it does not collide with 0016 (memory FTS, sibling PR).
-- Schema rollback: migrations/rollback/0017_m20e_memory_embeddings.down.sql.
--
-- Needs pgvector >= 0.5.0 (HNSW). Not conditional on purpose: the runner records
-- a migration by name, so a skipped table would never be created later and the
-- worker would fail at runtime instead. Without it, this fails up front with a
-- clear message and nothing is applied (the runner wraps the file in a transaction).
DO $$
DECLARE
  ext CONSTANT text := 'vector';
  min_version CONSTANT int[] := ARRAY[0,5,0];
  installed text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = ext) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = ext) THEN
      RAISE EXCEPTION 'M20e needs the pgvector extension ("%"), which this Postgres server does not provide. Install pgvector >= 0.5.0 on the server (image pgvector/pgvector:pg16, package postgresql-16-pgvector, or enable it in the managed provider) and run db:migrate again. Nothing was applied.', ext;
    END IF;
    BEGIN
      EXECUTE format('CREATE EXTENSION %I', ext);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'M20e needs the pgvector extension ("%"), but the migration role may not create it. Run CREATE EXTENSION %; as a superuser (or the provider''s admin role) and run db:migrate again. Nothing was applied.', ext, ext;
    END;
  END IF;
  SELECT extversion INTO installed FROM pg_extension WHERE extname = ext;
  IF string_to_array(regexp_replace(installed, '[^0-9.].*$', ''), '.')::int[] < min_version THEN
    RAISE EXCEPTION 'M20e needs pgvector >= % for HNSW indexes; this database has %. Install a newer pgvector on the server, run ALTER EXTENSION % UPDATE; and run db:migrate again. Nothing was applied.',
      array_to_string(min_version, '.'), installed, ext;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  model          text NOT NULL,
  embedding      vector(384) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, model)
);
CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_hnsw
  ON memory_item_embeddings USING hnsw (embedding vector_cosine_ops);
