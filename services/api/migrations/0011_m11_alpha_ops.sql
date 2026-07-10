-- M11: Private Alpha Operations + Reliability Hardening.

-- Self-service password reset (operator-delivered token in alpha — no
-- email sender). Tokens stored as SHA-256 only; single-use; short TTL.
CREATE TABLE password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at DESC);

-- Operator maintenance runs (ops:maintenance) — the status page shows the
-- last run. Counts only, never content.
CREATE TABLE ops_maintenance_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode          text NOT NULL,              -- 'dry-run' | 'apply'
  report        jsonb NOT NULL DEFAULT '{}',
  ran_at        timestamptz NOT NULL DEFAULT now()
);
