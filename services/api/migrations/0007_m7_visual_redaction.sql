-- M7: Visual Redaction v1. Screenshots and live frames are OCR-box masked
-- BEFORE storage; each moment keeps a values-free report of what happened.
-- Existing rows keep '{}' (pre-M7 = no report), nothing is rewritten.
ALTER TABLE context_moments
  ADD COLUMN IF NOT EXISTS image_redaction jsonb NOT NULL DEFAULT '{}';
