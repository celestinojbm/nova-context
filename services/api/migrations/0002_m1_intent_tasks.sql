-- M1: structured intent on moments + Nova's internal task list.

-- Parsed intent stored with the moment (see @nova/schema parsedIntentSchema).
ALTER TABLE context_moments ADD COLUMN intent_parsed jsonb;

-- Nova tasks: the first Tier-0 action target. Always traceable to the
-- Context Moment (and actions row) that produced them.
CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  moment_id     uuid REFERENCES context_moments(id) ON DELETE SET NULL,
  action_id     uuid REFERENCES actions(id) ON DELETE SET NULL,
  title         text NOT NULL,
  notes         text,
  priority      text NOT NULL DEFAULT 'normal',      -- 'low' | 'normal' | 'high'
  status        text NOT NULL DEFAULT 'open',        -- 'open' | 'done'
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX idx_tasks_moment ON tasks(moment_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
