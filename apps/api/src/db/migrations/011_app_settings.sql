-- System-wide settings changed from the admin pages (e.g. the date format the holiday web service expects).
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid,                                   -- no foreign key: settings outlive the accounts (reset script)
  updated_at  timestamptz NOT NULL DEFAULT now()
);
