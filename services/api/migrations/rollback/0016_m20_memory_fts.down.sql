-- Rollback of 0016_m20_memory_fts.sql. NOT run by db:migrate
-- (the runner only reads migrations/*.sql); apply by hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f services/api/migrations/rollback/0016_m20_memory_fts.down.sql
--
-- Order: 1) deploy the API WITHOUT M20 FTS (GET .../memory?q= reads
-- memory_items.tsv), 2) run this file. 0016 is additive, so this restores the
-- exact pre-0016 schema. Nothing is lost: tsv is a generated column (derived
-- from content) and re-applying 0016 rebuilds it and its GIN index.
-- The 0015 trigram index stays (it belongs to 0015).

DROP INDEX IF EXISTS idx_memory_items_tsv;
ALTER TABLE memory_items DROP COLUMN IF EXISTS tsv;
DELETE FROM schema_migrations WHERE name = '0016_m20_memory_fts.sql';
