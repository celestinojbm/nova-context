-- M20c: background memory consolidation (docs/design/memoria-m20.md §1.2–1.3).
-- Forward-only, additive. Nothing is deleted: duplicates become 'merged'
-- (canonical_id), contradicted facts 'superseded' (supersedes_id on the newer)
-- or 'contested' when a user-authored fact is involved. Every change is logged
-- per run in memory_consolidation_changes so a run can be reverted by run_id.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS canonical_id  uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES memory_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_memory_items_content_trgm ON memory_items USING gin (content gin_trgm_ops);

-- Runs reuse ops_maintenance_runs; `job` separates them from retention runs.
ALTER TABLE ops_maintenance_runs
  ADD COLUMN IF NOT EXISTS job         text NOT NULL DEFAULT 'retention',
  ADD COLUMN IF NOT EXISTS user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_ops_maintenance_runs_job ON ops_maintenance_runs(job, ran_at DESC);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  older_id    uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  newer_id    uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  detected_by text NOT NULL DEFAULT 'rule',
  resolution  text NOT NULL DEFAULT 'open',
  run_id      uuid REFERENCES ops_maintenance_runs(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_conflicts_resolution_chk
    CHECK (resolution IN ('open','newer_wins','user_resolved','false_positive'))
);
CREATE INDEX IF NOT EXISTS idx_memory_conflicts_user ON memory_conflicts(user_id, resolution);

CREATE TABLE IF NOT EXISTS memory_consolidation_changes (
  run_id             uuid NOT NULL REFERENCES ops_maintenance_runs(id) ON DELETE CASCADE,
  memory_item_id     uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  prev_status        text NOT NULL,
  new_status         text NOT NULL,
  prev_canonical_id  uuid,
  prev_supersedes_id uuid,
  PRIMARY KEY (run_id, memory_item_id)
);
