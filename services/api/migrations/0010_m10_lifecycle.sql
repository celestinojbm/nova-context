-- M10: Account Data Lifecycle + enrichment versioning.

-- Account tombstones: the ONLY thing that survives a full account deletion.
-- Counts and a salted-free email hash (dedup/abuse forensics) — never
-- captured content, never plaintext identity. No FK to users by design:
-- the user row is gone when this row is written.
CREATE TABLE account_tombstones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_user_id uuid NOT NULL,
  email_hash      text NOT NULL,        -- sha256(lowercased email)
  detail          jsonb NOT NULL DEFAULT '{}', -- row/object COUNTS only
  deleted_at      timestamptz NOT NULL DEFAULT now()
);

-- Enrichment versioning (M10): enrichment runs no longer overwrite history.
-- context_moments.summary/enrichment stay the CURRENT pointer; every run
-- appends here. Cascades with the moment (and therefore with the user).
CREATE TABLE enrichment_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id   uuid NOT NULL REFERENCES context_moments(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  summary     text,
  enrichment  jsonb NOT NULL DEFAULT '{}',
  provider    text,                     -- 'llm' | 'local'
  model       text,                     -- model id when the provider ran one
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (moment_id, version)
);
CREATE INDEX idx_enrichment_versions_moment ON enrichment_versions(moment_id, version DESC);
