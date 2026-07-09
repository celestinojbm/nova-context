-- M8: Media Pipeline v1. Screenshots/frames move out of context_moments
-- .payload jsonb into moment_media + encrypted object storage. Existing
-- rows are untouched (legacy inline media migrates via the manual
-- `media:backfill` command — see docs/AUTH.md §Media pipeline).

-- moment_media (created in 0000, never populated until now) gains the
-- columns the pipeline needs. user_id is denormalized for direct per-user
-- isolation checks on media routes.
ALTER TABLE moment_media ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
UPDATE moment_media mm SET user_id = m.user_id
  FROM context_moments m WHERE m.id = mm.moment_id AND mm.user_id IS NULL;
ALTER TABLE moment_media ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE moment_media ADD COLUMN IF NOT EXISTS width int;
ALTER TABLE moment_media ADD COLUMN IF NOT EXISTS height int;
-- Redaction linkage: the visual-redaction outcome this media was stored under.
ALTER TABLE moment_media ADD COLUMN IF NOT EXISTS redaction_state text NOT NULL DEFAULT 'unknown';
ALTER TABLE moment_media ADD COLUMN IF NOT EXISTS thumb_key text;
CREATE INDEX IF NOT EXISTS idx_media_user ON moment_media(user_id);

-- M8 search-quality pass: non-sensitive OCR text extracted from redacted
-- screenshots becomes searchable alongside the DOM text.
ALTER TABLE context_moments ADD COLUMN IF NOT EXISTS ocr_text text;

CREATE OR REPLACE FUNCTION context_moments_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('english', coalesce(NEW.intent_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.source_meta->>'title', '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.extracted_text, ''), 200000)), 'C') ||
    setweight(to_tsvector('english', left(coalesce(NEW.ocr_text, ''), 50000)), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_context_moments_tsv ON context_moments;
CREATE TRIGGER trg_context_moments_tsv
  BEFORE INSERT OR UPDATE OF extracted_text, intent_text, source_meta, ocr_text
  ON context_moments
  FOR EACH ROW EXECUTE FUNCTION context_moments_tsv_update();
