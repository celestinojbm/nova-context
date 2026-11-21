-- Visible ingest/enrichment status (Zep wait_status analog).
-- Additive and nullable: stored enrichment_status values are unchanged.
-- 'expired' is computed at read time when now() >= enrichment_expires_at
-- (or captured_at + 7 days) and the row is still pending/processing.
-- Numbered 0018 so it does not collide with unmerged M20 migrations 0014–0017.

ALTER TABLE context_moments
  ADD COLUMN IF NOT EXISTS enrichment_error_code text,
  ADD COLUMN IF NOT EXISTS enrichment_wait_reason text,
  ADD COLUMN IF NOT EXISTS enrichment_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_moments_ingest_status
  ON context_moments (user_id, project_id, enrichment_status, enrichment_expires_at)
  WHERE enrichment_status IN ('pending', 'processing', 'failed');
