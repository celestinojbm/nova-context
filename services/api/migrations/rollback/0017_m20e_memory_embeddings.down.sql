-- Rollback of 0017_m20e_memory_embeddings.sql. NOT run by db:migrate
-- (the runner only reads migrations/*.sql); apply by hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f services/api/migrations/rollback/0017_m20e_memory_embeddings.down.sql
--
-- Order: 1) deploy a worker WITHOUT M20e, or keep NOVA_MEMORY_EMBEDDINGS=off
-- (the default: the table is only read with the local embedder on), 2) run
-- this file. 0017 is additive, so this restores the exact pre-0017 schema.
-- Lost: the stored 384-dim vectors (derived data; the next consolidation run
-- with embeddings on recomputes them). The pgvector extension stays: 0000_init
-- created it and the 1536-dim `embeddings` table depends on it.
-- 0019 (M20i) adds a column to this table: roll it back FIRST (LIFO). Otherwise
-- re-applying 0017 would leave 0019 recorded but its column missing, so this
-- refuses and changes nothing.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0019_m20i_embedding_content_hash.sql') THEN
    RAISE EXCEPTION 'Roll back 0019 first (rollback/0019_m20i_embedding_content_hash.down.sql): it depends on memory_item_embeddings. Nothing was rolled back.';
  END IF;
END $$;

DROP TABLE IF EXISTS memory_item_embeddings;  -- also drops its HNSW index
DELETE FROM schema_migrations WHERE name = '0017_m20e_memory_embeddings.sql';
