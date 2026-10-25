-- Meetings recorded from the archive (ثبت از سوابق): held before the system was used, entered with their real
-- times, attendance, decisions and the scanned signed minutes. Nothing about them is notified, and their
-- resolutions are kept for the record (no reminders).
ALTER TABLE meetings ADD COLUMN archival boolean NOT NULL DEFAULT false;
ALTER TABLE resolutions ADD COLUMN archival boolean NOT NULL DEFAULT false;
