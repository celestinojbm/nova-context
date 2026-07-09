-- Nova Context — initial schema.
-- Source of truth: docs/BUILD_PLAN.md §4 "First database schema".
-- Applied verbatim, plus the tsvector maintenance trigger the DDL notes call for.

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector

-- Users --------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,               -- login identity
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                          -- soft delete; hard-purge job removes rows + media
);

-- Projects: the organizing unit context moments link to ----------------------
CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  local_only    boolean NOT NULL DEFAULT false,      -- pinned local-only; excluded from cloud sync
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_user ON projects(user_id) WHERE archived = false;

-- Context Moments: the atomic captured unit --------------------------------
CREATE TABLE context_moments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,  -- null until linked
  source_mode    text NOT NULL,                       -- 'instant_capture' | 'live_context'
  source_meta    jsonb NOT NULL DEFAULT '{}',         -- {url, title, app, tab_id, favicon, viewport}
  payload        jsonb NOT NULL DEFAULT '{}',         -- raw normalized capture draft (DOM extract, UI semantics)
  extracted_text text,                                -- flattened searchable text (DOM + OCR + transcript)
  intent_text    text,                                -- user's spoken/typed instruction utterance
  summary        text,                                -- enrichment output; null until worker runs
  captured_at    timestamptz NOT NULL DEFAULT now(),
  enriched_at    timestamptz,                         -- set when enrichment completes
  redaction_state text NOT NULL DEFAULT 'pending',    -- 'pending' | 'applied' | 'skipped'
  tsv            tsvector,                            -- full-text index vector (maintained by trigger)
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_moments_user_time ON context_moments(user_id, captured_at DESC);
CREATE INDEX idx_moments_project   ON context_moments(project_id);
CREATE INDEX idx_moments_tsv       ON context_moments USING gin(tsv);

-- tsvector maintenance: extracted_text + intent_text + title are searchable.
CREATE FUNCTION context_moments_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('english', coalesce(NEW.intent_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.source_meta->>'title', '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.extracted_text, ''), 200000)), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_context_moments_tsv
  BEFORE INSERT OR UPDATE OF extracted_text, intent_text, source_meta
  ON context_moments
  FOR EACH ROW EXECUTE FUNCTION context_moments_tsv_update();

-- Media attached to a moment (frames, audio clips) -------------------------
CREATE TABLE moment_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id     uuid NOT NULL REFERENCES context_moments(id) ON DELETE CASCADE,
  kind          text NOT NULL,                        -- 'frame' | 'audio' | 'thumbnail'
  storage_key   text NOT NULL,                        -- S3-compatible object key; client-side encrypted
  content_type  text NOT NULL,
  bytes         bigint,
  encrypted     boolean NOT NULL DEFAULT true,        -- media is client-side encrypted at rest
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_moment ON moment_media(moment_id);

-- Entities: people/orgs/things extracted from moments (relational, not a graph DB)
CREATE TABLE entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,                        -- 'person' | 'org' | 'topic' | 'url' | 'other'
  name          text NOT NULL,
  normalized    text NOT NULL,                        -- lowercased/canonical form for dedup
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, normalized)
);
CREATE INDEX idx_entities_user ON entities(user_id, kind);

-- Entity mentions: edges from a moment to an entity ------------------------
CREATE TABLE entity_mentions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id     uuid NOT NULL REFERENCES context_moments(id) ON DELETE CASCADE,
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence    real,                                 -- extractor confidence 0..1
  span          jsonb,                                -- optional {start,end} in extracted_text
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (moment_id, entity_id)
);
CREATE INDEX idx_mentions_entity ON entity_mentions(entity_id);

-- Memory items: durable, retrievable memory derived from moments -----------
CREATE TABLE memory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moment_id     uuid REFERENCES context_moments(id) ON DELETE CASCADE,
  layer         text NOT NULL,                        -- 'working'|'session'|'project'|'semantic'|'long_term'
  content       text NOT NULL,                        -- the memory's text
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_memory_user_layer ON memory_items(user_id, layer);

-- Embeddings: one row per embeddable item (moment or memory) ---------------
-- pgvector 1536-dim (text-embedding-3-small). Start with ivfflat; note below.
CREATE TABLE embeddings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_kind    text NOT NULL,                        -- 'moment' | 'memory_item'
  owner_id      uuid NOT NULL,                        -- FK enforced in app layer (polymorphic)
  model         text NOT NULL,                        -- embedding model id, for migration safety
  embedding     vector(1536) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Index note: ivfflat needs data + ANALYZE before it helps and requires a
-- probes setting at query time. Start with ivfflat (lists=100) for MVP; switch
-- to HNSW (m=16, ef_construction=64) if recall/latency demands and memory allows.
CREATE INDEX idx_embeddings_ivfflat ON embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_embeddings_owner ON embeddings(owner_kind, owner_id);

-- Actions: the output of the Action Engine, risk-tiered --------------------
CREATE TYPE action_status AS ENUM ('proposed','awaiting_approval','approved','executing','done','failed','rejected');
CREATE TABLE actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moment_id      uuid REFERENCES context_moments(id) ON DELETE SET NULL,
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,
  action_type    text NOT NULL,                       -- 'nova_task' | 'notion_page' | ...
  risk_tier      smallint NOT NULL,                   -- 0 auto | 1 preview-confirm | 2 explicit+audit
  status         action_status NOT NULL DEFAULT 'proposed',
  payload        jsonb NOT NULL,                       -- validated, allowlisted operation params
  result         jsonb,                                -- adapter result (e.g. Notion page url/id)
  approved_by    uuid REFERENCES users(id),            -- who confirmed (Tier 1/2)
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_actions_user_status ON actions(user_id, status);
CREATE INDEX idx_actions_moment ON actions(moment_id);

-- Integration connections: OAuth tokens (encrypted at rest via KMS) --------
CREATE TABLE integration_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL,                       -- 'notion' | 'github' | ...
  external_account text,                              -- provider account label
  token_ciphertext bytea NOT NULL,                    -- KMS-encrypted token blob; NEVER synced to client
  scopes         text[],
  status         text NOT NULL DEFAULT 'active',       -- 'active' | 'revoked' | 'error'
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- Audit log: user-readable record of every capture, action, integration call
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type     text NOT NULL,                       -- 'capture'|'action.propose'|'action.execute'|'integration.call'|...
  subject_kind   text,                                -- 'moment'|'action'|'connection'
  subject_id     uuid,
  detail         jsonb NOT NULL DEFAULT '{}',          -- NO context payloads, NO secrets
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);
