-- Retrieval instrumentation for the theory's falsification test
-- (docs/THEORY_OF_HUMAN_DIGITAL_CONTEXT.md §6, docs/ROADMAP.md Horizon 2):
-- "are captures with an intent utterance more RETRIEVED than those without?"
--
-- One row per moment that a text-query search (/v1/memory/search with a
-- non-empty query) has returned. Filter-only listings and the timeline are
-- browsing, not recall, and do not count. Ids, counters and timestamps
-- only: never the query text, never content.
--
--   search_hits  times the moment appeared in a query search's results
--   best_rank    best (lowest) 1-based position it ever reached, so reports
--                can restrict "retrieved" to the top-k without new tracking
--
-- Bounded by the number of moments (upsert, not an event log), so it needs no
-- pruning. Cascades with the moment and with the account. Additive; rollback:
-- services/api/migrations/rollback/0020_moment_retrievals.down.sql

CREATE TABLE IF NOT EXISTS moment_retrievals (
  moment_id          uuid PRIMARY KEY REFERENCES context_moments(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_hits        integer NOT NULL DEFAULT 1 CHECK (search_hits > 0),
  best_rank          integer NOT NULL CHECK (best_rank > 0),
  first_retrieved_at timestamptz NOT NULL DEFAULT now(),
  last_retrieved_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moment_retrievals_user
  ON moment_retrievals (user_id, last_retrieved_at);
