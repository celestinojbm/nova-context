-- M20a: fact extractor writes semantic facts into memory_items.
-- Design: docs/design/memoria-m20.md (§1.1, §1.2, §4). Forward-only, additive.
-- Namespaces/tokens (M20b) and consolidation (M20c) are NOT part of this migration;
-- canonical_id / supersedes_id arrive with M20c.

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'active',  -- active|merged|superseded|contested
  ADD COLUMN IF NOT EXISTS valid_from   timestamptz,                     -- captured_at of the source moment
  ADD COLUMN IF NOT EXISTS author       text NOT NULL DEFAULT 'model',   -- model|user|assistant
  ADD COLUMN IF NOT EXISTS content_hash text,                            -- sha256(normalized content)
  ADD COLUMN IF NOT EXISTS extractor    text,                            -- e.g. 'heuristic-v1'
  ADD COLUMN IF NOT EXISTS local_only   boolean NOT NULL DEFAULT false;  -- inherited from projects.local_only

ALTER TABLE memory_items
  ADD CONSTRAINT memory_items_status_chk CHECK (status IN ('active','merged','superseded','contested')),
  ADD CONSTRAINT memory_items_author_chk CHECK (author IN ('model','user','assistant'));

-- Idempotent extraction: re-enriching a moment never duplicates its facts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_items_moment_hash
  ON memory_items(moment_id, content_hash) WHERE moment_id IS NOT NULL AND content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_items_user_hash ON memory_items(user_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_items_user_status ON memory_items(user_id, status);

-- N moments can back one fact (consolidation in M20c joins sources here).
CREATE TABLE IF NOT EXISTS memory_item_sources (
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  moment_id      uuid NOT NULL REFERENCES context_moments(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, moment_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_item_sources_moment ON memory_item_sources(moment_id);
