-- M20b: memory namespaces, per-namespace tokens for assistants, Markdown export.
-- Design: docs/design/memoria-m20.md §2 (incl. §2.4). Forward-only, additive.

CREATE TABLE IF NOT EXISTS memory_namespaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        text NOT NULL,                     -- 'default', 'proyecto/dona', 'asistente/claude'
  kind        text NOT NULL,                     -- default|project|assistant|custom
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  archived_at timestamptz,                       -- DELETE /v1/namespaces/:slug archives
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug),
  CONSTRAINT memory_namespaces_kind_chk CHECK (kind IN ('default','project','assistant','custom'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_namespaces_project
  ON memory_namespaces(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS namespace_id uuid REFERENCES memory_namespaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_memory_items_namespace ON memory_items(namespace_id, status);

-- Tokens: only the sha256 is stored; plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS namespace_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               text NOT NULL,
  token_hash          text NOT NULL UNIQUE,
  token_prefix        text NOT NULL,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  rotated_from        uuid REFERENCES namespace_tokens(id) ON DELETE SET NULL,
  rate_limit_per_hour integer NOT NULL DEFAULT 600 CHECK (rate_limit_per_hour BETWEEN 1 AND 100000),
  usage_window_start  timestamptz,
  usage_count         integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_namespace_tokens_user ON namespace_tokens(user_id);

CREATE TABLE IF NOT EXISTS namespace_token_grants (
  token_id     uuid NOT NULL REFERENCES namespace_tokens(id) ON DELETE CASCADE,
  namespace_id uuid NOT NULL REFERENCES memory_namespaces(id) ON DELETE CASCADE,
  scopes       text[] NOT NULL,
  PRIMARY KEY (token_id, namespace_id),
  CONSTRAINT namespace_token_grants_scopes_chk
    CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['memory:read','memory:write','memory:export']::text[])
);

-- Backfill: every user gets 'default'; every non-archived project gets a 'project' namespace.
INSERT INTO memory_namespaces (user_id, slug, kind)
  SELECT id, 'default', 'default' FROM users
  ON CONFLICT (user_id, slug) DO NOTHING;
INSERT INTO memory_namespaces (user_id, slug, kind, project_id)
  SELECT p.user_id, 'proyecto/' || left(p.id::text, 8), 'project', p.id
  FROM projects p WHERE p.archived = false
  ON CONFLICT DO NOTHING;
UPDATE memory_items mi SET namespace_id = COALESCE(
    (SELECT n.id FROM context_moments m JOIN memory_namespaces n ON n.project_id = m.project_id
      WHERE m.id = mi.moment_id),
    (SELECT n.id FROM memory_namespaces n WHERE n.user_id = mi.user_id AND n.slug = 'default'))
  WHERE mi.namespace_id IS NULL;
