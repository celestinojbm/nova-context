-- M2: asynchronous enrichment lifecycle on Context Moments.

ALTER TABLE context_moments
  ADD COLUMN enrichment_status text NOT NULL DEFAULT 'pending',
    -- 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  ADD COLUMN enrichment jsonb,        -- {tags, priority_signal, action_candidates, project_candidates, provider, model, embedded}
  ADD COLUMN enrichment_error text;   -- last failure message (final attempt)

-- Moments captured before the worker existed were never enriched.
UPDATE context_moments SET enrichment_status = 'skipped' WHERE enriched_at IS NULL;

CREATE INDEX idx_moments_enrichment_status ON context_moments(enrichment_status);
