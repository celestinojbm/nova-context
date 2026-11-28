-- Rollback of 0020_moment_retrievals.sql. NOT run by db:migrate
-- (the runner only reads migrations/*.sql); apply by hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f services/api/migrations/rollback/0020_moment_retrievals.down.sql
--
-- Order: 1) deploy an API WITHOUT the retrieval tracking (it upserts into this
-- table; with the table gone the fire-and-forget insert just fails silently,
-- but the log noise is avoidable), 2) run this file. 0020 is additive, so this
-- restores the exact pre-0020 schema. Only the retrieval counters are lost.

DROP TABLE IF EXISTS moment_retrievals;
DELETE FROM schema_migrations WHERE name = '0020_moment_retrievals.sql';
