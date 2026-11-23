-- Rollback of 0014_m20b_namespaces_tokens.sql. NOT run by db:migrate
-- (the runner only reads migrations/*.sql); apply by hand, in ONE transaction,
-- with the API stopped:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f services/api/migrations/rollback/0014_m20b_namespaces_tokens.down.sql
--
-- 0014 is additive, so this restores the exact pre-0014 schema. What is LOST:
-- every namespace token (connected assistants stop working — intended), every
-- custom/assistant namespace and the namespace of each fact. Facts themselves
-- (memory_items rows) are kept, including those written by tokens
-- (author = 'assistant'). Take a backup first if those must be recoverable.
-- Deploy the pre-M20b API code BEFORE running this: the M20b code needs these tables.

DROP TABLE IF EXISTS namespace_token_grants;
DROP TABLE IF EXISTS namespace_tokens;
DROP INDEX IF EXISTS idx_memory_items_namespace;
ALTER TABLE memory_items DROP COLUMN IF EXISTS namespace_id;
DROP TABLE IF EXISTS memory_namespaces;  -- also drops uq_memory_namespaces_project
DELETE FROM schema_migrations WHERE name = '0014_m20b_namespaces_tokens.sql';
