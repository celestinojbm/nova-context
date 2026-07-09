-- M0 is single-user (MVP_SCOPE): bootstrap the dev user and one starter
-- project so the capture → link → list loop is exercisable immediately.
-- Real signup arrives with auth; this seed is idempotent.
INSERT INTO users (email, display_name)
VALUES ('dev@nova.local', 'Nova Dev User')
ON CONFLICT (email) DO NOTHING;

INSERT INTO projects (user_id, name, description)
SELECT u.id, 'Inbox', 'Default project for unsorted context moments'
FROM users u
WHERE u.email = 'dev@nova.local'
  AND NOT EXISTS (
    SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.name = 'Inbox'
  );
