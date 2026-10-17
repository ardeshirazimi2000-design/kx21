-- Specimen signatures (نمونه امضا) registered by the secretariat, and invitation letters requested by the meetings system.

ALTER TABLE users
  ADD COLUMN signature_key        text,                  -- encrypted image in storage (PNG/JPEG)
  ADD COLUMN signature_mime       text,
  ADD COLUMN signature_updated_at timestamptz,
  ADD COLUMN signature_updated_by uuid REFERENCES users(id);

-- The specimen image in use at signing time, so later changes never alter a signed letter.
ALTER TABLE signatures
  ADD COLUMN image_key  text,
  ADD COLUMN image_mime text;

INSERT INTO permissions (key, name, module) VALUES ('signatures.manage', 'معرفی و ثبت نمونه امضای اشخاص', 'مکاتبات')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key) SELECT id, 'signatures.manage' FROM roles WHERE key IN ('admin', 'secretariat')
  ON CONFLICT DO NOTHING;

-- Invitation letters (نامه دعوت) drafted for a meeting's invitees at the meetings system's request.
CREATE TABLE meeting_invitation_letters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_external_id uuid NOT NULL REFERENCES meetings_cache(external_id),
  invitee_external_id uuid NOT NULL,
  invitee_name        text NOT NULL,
  letter_id           uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  requested_by        text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_invitation_letters_meeting_idx ON meeting_invitation_letters (meeting_external_id);
