-- شورای گفت‌وگو: the council and its expert group are meeting bodies like commissions (members, meetings, agenda,
-- votes, minutes, resolutions); a council case moves between them, provincially and then nationally.

-- Iran Chamber (اتاق ایران): the one national chamber, home of the national council and its expert group.
ALTER TABLE chambers ADD COLUMN kind text NOT NULL DEFAULT 'provincial' CHECK (kind IN ('provincial', 'national'));
CREATE UNIQUE INDEX chambers_one_national ON chambers ((true)) WHERE kind = 'national';

ALTER TABLE commissions ADD COLUMN body_type text NOT NULL DEFAULT 'commission' CHECK (body_type IN ('commission', 'expert_group', 'council'));
-- دبیر شورا: the chamber's president, who approves referral to the national council and reopens cases himself.
ALTER TABLE commissions ADD COLUMN council_secretary_id uuid REFERENCES users(id);
CREATE UNIQUE INDEX commissions_one_council_body ON commissions (chamber_id, body_type) WHERE body_type <> 'commission' AND status = 'active';

CREATE SEQUENCE council_case_seq;

CREATE TABLE council_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,                         -- کد رهگیری
  title                 text NOT NULL,
  description           text,
  origin_chamber_id     uuid NOT NULL REFERENCES chambers(id),
  origin_commission_id  uuid REFERENCES commissions(id),
  origin_resolution_id  uuid REFERENCES resolutions(id),
  level                 text NOT NULL DEFAULT 'provincial' CHECK (level IN ('provincial', 'national')),
  status                text NOT NULL DEFAULT 'expert_review'
                        CHECK (status IN ('expert_review', 'on_agenda', 'pending_approval', 'resolved', 'returned', 'closed')),
  priority              text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  confidential          boolean NOT NULL DEFAULT false,
  due_date              date,                                          -- deadline of the current stage, from a resolution
  outcome               text,                                          -- نتیجهٔ نهایی
  national_reached_at   timestamptz,
  provincial_agenda_at  timestamptz,                                   -- first put on a provincial council's agenda
  national_agenda_at    timestamptz,
  due_soon_notified_at  timestamptz,
  overdue_notified_at   timestamptz,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz
);
CREATE INDEX council_cases_origin_idx ON council_cases (origin_chamber_id, status);
CREATE INDEX council_cases_national_idx ON council_cases (status) WHERE national_reached_at IS NOT NULL;
CREATE UNIQUE INDEX council_cases_one_per_resolution ON council_cases (origin_resolution_id) WHERE origin_resolution_id IS NOT NULL;

-- The case's timeline: append-only, like the audit log.
CREATE TABLE council_case_events (
  id             bigserial PRIMARY KEY,
  case_id        uuid NOT NULL REFERENCES council_cases(id),
  event          text NOT NULL,
  from_level     text,
  from_status    text,
  to_level       text,
  to_status      text,
  actor_id       uuid REFERENCES users(id),
  reason         text,
  meeting_id     uuid REFERENCES meetings(id),
  resolution_id  uuid REFERENCES resolutions(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX council_case_events_case_idx ON council_case_events (case_id, id);
CREATE FUNCTION council_case_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'council_case_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER council_case_events_no_change BEFORE UPDATE OR DELETE ON council_case_events
  FOR EACH ROW EXECUTE FUNCTION council_case_events_append_only();

-- A case on a meeting's agenda (expert or council meeting).
ALTER TABLE agenda_items ADD COLUMN council_case_id uuid REFERENCES council_cases(id);
CREATE INDEX agenda_items_case_idx ON agenda_items (council_case_id) WHERE council_case_id IS NOT NULL;

-- Attachments of a case.
ALTER TABLE documents ADD COLUMN council_case_id uuid REFERENCES council_cases(id);
