-- M6: Notion as the first Tier-1 external adapter — job-based execution and
-- per-user OAuth connections. No existing data is touched.

-- Approved external actions now pass through a queue instead of executing
-- inline in the HTTP request: proposed → queued → executing → done|failed.
-- ('done' is the terminal "executed" state used since M1/M2; transient
-- provider failures retry inside the job before settling on 'failed'.)
ALTER TYPE action_status ADD VALUE IF NOT EXISTS 'queued';

-- One-time OAuth state values (CSRF protection for the connect flow).
-- Stored hashed, bound to the initiating user, 10-minute lifetime, single use.
CREATE TABLE oauth_states (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,                       -- 'notion'
  state_hash    text NOT NULL UNIQUE,                -- sha256(state), hex
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);
CREATE INDEX idx_oauth_states_user ON oauth_states(user_id);

-- Provider metadata that is not a secret (workspace id/name, bot id).
-- The token itself stays in token_ciphertext (AES-256-GCM, never plaintext).
ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}';
