-- M5: real authentication + per-user isolation.
--
-- Existing local data is NOT touched: every M0–M4 row already carries a
-- user_id pointing at the seeded dev user (dev@nova.local). That user simply
-- becomes a normal account. It has no password until one is set
-- (`pnpm --filter @nova/api db:seed-dev`), so it cannot log in by default.

-- Password credential. NULL = no password login (e.g. the seeded dev user
-- until db:seed-dev runs). Format: scrypt$N$r$p$salt$hash (base64url).
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

-- Server-side sessions. The client holds an opaque random token; only its
-- SHA-256 hash is stored, so a database leak does not leak usable tokens.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,                -- sha256(token), hex
  kind          text NOT NULL,                       -- 'web' | 'extension'
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,                         -- logout / revocation
  label         text                                 -- e.g. user agent, for the sessions UI
);
CREATE INDEX idx_sessions_user ON sessions(user_id, created_at DESC);

-- Short-lived one-time codes minted by an authenticated web session and
-- claimed by the browser extension to obtain its own session token.
CREATE TABLE pairing_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash     text NOT NULL UNIQUE,                -- sha256(code), hex
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  claimed_at    timestamptz
);
CREATE INDEX idx_pairing_codes_user ON pairing_codes(user_id);
