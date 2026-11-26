-- Rollback of 0019_m20i_embedding_content_hash.sql. NOT run by db:migrate
-- (the runner only reads migrations/*.sql); apply by hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f services/api/migrations/rollback/0019_m20i_embedding_content_hash.down.sql
--
-- Order: 1) deploy a worker WITHOUT M20i (it writes content_sha256), or keep
-- NOVA_MEMORY_EMBEDDINGS=off, 2) run this file. 0019 is additive, so this
-- restores the exact pre-0019 schema. Vectors stay; only the hashes are lost,
-- which puts back the pre-M20i behavior (an edited fact keeps its old vector).

ALTER TABLE memory_item_embeddings DROP COLUMN IF EXISTS content_sha256;
DELETE FROM schema_migrations WHERE name = '0019_m20i_embedding_content_hash.sql';
