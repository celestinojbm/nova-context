-- M9: Media Reliability + Storage Operations.

-- Failed blob deletions must never vanish silently: they land here and are
-- retried by the manual `media:cleanup` command (and surfaced in storage
-- usage). No FK to users/moments — the whole point is that these rows
-- outlive the DB rows that referenced the blob.
CREATE TABLE media_delete_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  storage_key   text NOT NULL UNIQUE,
  reason        text NOT NULL DEFAULT 'delete_failed',
  attempts      int  NOT NULL DEFAULT 1,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_delete_queue_user ON media_delete_queue(user_id);

-- Storage accounting: thumbnails are separate objects with their own size.
ALTER TABLE moment_media ADD COLUMN IF NOT EXISTS thumb_bytes bigint;
