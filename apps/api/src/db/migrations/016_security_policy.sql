-- Security policy (AFTA identification/authentication and product access): temporary lockout after failed sign-ins,
-- the last sign-in shown to the user, and sessions that end when idle or when too many are open.

-- System-wide settings changed from the admin pages (the security policy under key 'security'). Migration 012 removed
-- the earlier table together with the holiday web service that was its only user.
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid,                                   -- no foreign key: settings outlive the accounts (reset script)
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN failed_logins int NOT NULL DEFAULT 0;          -- consecutive failures (lockout counter)
ALTER TABLE users ADD COLUMN failed_since_login int NOT NULL DEFAULT 0;     -- failures since the last successful sign-in
ALTER TABLE users ADD COLUMN last_failed_login_at timestamptz;
ALTER TABLE users ADD COLUMN locked_until timestamptz;
ALTER TABLE users ADD COLUMN last_login_ip text;

ALTER TABLE refresh_tokens ADD COLUMN client text NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'mobile'));
ALTER TABLE refresh_tokens ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
-- A rotated token names its successor's session, so one sign-in stays one session across rotations.
ALTER TABLE refresh_tokens ADD COLUMN session_id uuid;
UPDATE refresh_tokens SET session_id = id WHERE session_id IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN session_id SET NOT NULL;
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);
CREATE INDEX refresh_tokens_user_open_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
