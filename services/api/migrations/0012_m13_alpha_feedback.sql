-- M13: lightweight bug/feedback intake for the private alpha.
-- message is USER-AUTHORED feedback text (never captured page content —
-- the API rejects pasted data URLs and screenshots have no path in).
CREATE TABLE IF NOT EXISTS alpha_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'bug', 'privacy', 'capture_failure', 'search_failure',
    'live_failure', 'notion_failure', 'ux', 'feature'
  )),
  message text NOT NULL CHECK (char_length(message) <= 4000),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'done')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alpha_feedback_user_idx
  ON alpha_feedback (user_id, created_at DESC);
