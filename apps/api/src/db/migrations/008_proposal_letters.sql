-- Letter of a national proposal (نامه پیشنهاد ملی): drafted from the network's data, edited by the coordinator.
ALTER TABLE network_proposals
  ADD COLUMN letter_addressee  text,
  ADD COLUMN letter_subject    text,
  ADD COLUMN letter_body       text,
  ADD COLUMN letter_updated_by uuid REFERENCES users(id),
  ADD COLUMN letter_updated_at timestamptz;
