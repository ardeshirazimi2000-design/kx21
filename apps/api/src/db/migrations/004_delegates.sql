-- Representatives (نماینده) attending a meeting on behalf of an invitee (e.g. an organisation's CEO).
-- Responsibility (resolutions, notices) stays with the invitee; the delegate only attends.
CREATE TABLE meeting_delegates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id         uuid NOT NULL REFERENCES chambers(id),
  meeting_id         uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  principal_id       uuid NOT NULL REFERENCES users(id),
  delegate_id        uuid NOT NULL REFERENCES users(id),
  letter_document_id uuid REFERENCES documents(id),
  note               text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_by         uuid REFERENCES users(id),
  revoked_at         timestamptz,
  revoke_reason      text
);
CREATE UNIQUE INDEX meeting_delegates_one_active ON meeting_delegates (meeting_id, principal_id) WHERE status = 'active';
CREATE UNIQUE INDEX meeting_delegates_delegate_active ON meeting_delegates (meeting_id, delegate_id) WHERE status = 'active';

-- The person who actually checked in / voted for an invitee.
ALTER TABLE attendance ADD COLUMN proxy_user_id uuid REFERENCES users(id);
ALTER TABLE votes ADD COLUMN cast_by uuid REFERENCES users(id);
