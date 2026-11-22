-- Rollback of 0015_m20c_memory_consolidation.sql. NOT run by db:migrate
-- (the runner only reads migrations/*.sql); apply by hand, in ONE transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -f services/api/migrations/rollback/0015_m20c_memory_consolidation.down.sql
--
-- Order: 1) deploy a worker WITHOUT M20c (it reads canonical_id/supersedes_id),
-- 2) run this file, 3) deploy the API without the `job` filter in routes-ops.
-- What it does: undoes every applied, non-reverted consolidation run (newest
-- first, from the change log) so no fact stays merged/superseded/contested
-- without the links that explain it; then drops everything 0015 added.
-- Lost on purpose: consolidation run history and memory_conflicts.
-- pg_trgm stays installed (harmless; other objects may depend on it).

DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.memory_consolidation_changes') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT id FROM ops_maintenance_runs
    WHERE job = 'memory-consolidation' AND mode = 'apply' AND reverted_at IS NULL
    ORDER BY ran_at DESC, id DESC
  LOOP
    DELETE FROM memory_item_sources s USING memory_consolidation_sources cs
     WHERE cs.run_id = r.id AND s.memory_item_id = cs.memory_item_id AND s.moment_id = cs.moment_id;
    UPDATE memory_items mi
       SET status = ch.prev_status, canonical_id = ch.prev_canonical_id, supersedes_id = ch.prev_supersedes_id
      FROM memory_consolidation_changes ch
     WHERE ch.run_id = r.id AND ch.memory_item_id = mi.id;
  END LOOP;
END $$;

DROP TABLE IF EXISTS memory_consolidation_sources;
DROP TABLE IF EXISTS memory_consolidation_changes;
DROP TABLE IF EXISTS memory_conflicts;

-- Consolidation runs would otherwise show up as retention runs on /v1/ops/status.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ops_maintenance_runs' AND column_name = 'job') THEN
    DELETE FROM ops_maintenance_runs WHERE job <> 'retention';
  END IF;
END $$;
DROP INDEX IF EXISTS idx_ops_maintenance_runs_job;
ALTER TABLE ops_maintenance_runs
  DROP COLUMN IF EXISTS reverted_at,
  DROP COLUMN IF EXISTS user_id,
  DROP COLUMN IF EXISTS job;

DROP INDEX IF EXISTS idx_memory_items_content_trgm;
ALTER TABLE memory_items
  DROP COLUMN IF EXISTS supersedes_id,
  DROP COLUMN IF EXISTS canonical_id;

DELETE FROM schema_migrations WHERE name = '0015_m20c_memory_consolidation.sql';
