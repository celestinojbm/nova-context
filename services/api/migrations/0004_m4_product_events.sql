-- M4: privacy-preserving funnel instrumentation. Product events record THAT
-- something happened, never captured content — enforced at the API layer by
-- an event-name allowlist and value-length caps on props.
CREATE TABLE product_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL,                       -- allowlisted name, e.g. 'instant_capture_saved'
  props       jsonb NOT NULL DEFAULT '{}',         -- numbers/booleans/short enums only
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_events_user_time ON product_events(user_id, created_at DESC);
CREATE INDEX idx_product_events_event ON product_events(event);
