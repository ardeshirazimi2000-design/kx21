-- Approved minutes can be reopened by the chamber admin with a reason; the last reopening is kept on the
-- minutes (every one is in the audit log, and every earlier text in minutes_versions).
ALTER TABLE minutes ADD COLUMN reopened_at timestamptz;
ALTER TABLE minutes ADD COLUMN reopened_by uuid REFERENCES users(id);
ALTER TABLE minutes ADD COLUMN reopen_reason text;

-- The lock on approved minutes stays; the only change allowed is a recorded reopening, which brings the
-- minutes back to draft with its text untouched (so the approved text remains in minutes_versions).
CREATE OR REPLACE FUNCTION minutes_lock() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.status = 'draft' AND NEW.body = OLD.body AND NEW.reopened_at IS DISTINCT FROM OLD.reopened_at
       AND NEW.reopen_reason IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'approved minutes are locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
