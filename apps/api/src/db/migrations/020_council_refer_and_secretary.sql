-- An expert meeting's resolution refers a case to the council (council_pending) before the council's meeting is set,
-- and «دبیر شورا» is a position of its own in a council (one holder, like the chair and the secretary).
ALTER TABLE council_cases DROP CONSTRAINT council_cases_status_check;
ALTER TABLE council_cases ADD CONSTRAINT council_cases_status_check
  CHECK (status IN ('expert_review', 'council_pending', 'on_agenda', 'pending_approval', 'resolved', 'returned', 'closed'));
CREATE INDEX council_cases_open_idx ON council_cases (status) WHERE status IN ('expert_review', 'council_pending', 'on_agenda', 'pending_approval', 'returned');

DROP INDEX memberships_one_chair;
CREATE UNIQUE INDEX memberships_one_chair ON commission_memberships (commission_id, position)
  WHERE status = 'active' AND position IN ('chair', 'vice_chair', 'secretary', 'council_secretary');
