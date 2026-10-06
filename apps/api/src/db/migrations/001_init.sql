-- سامانه کمیسیون‌های تخصصی اتاق بازرگانی — schema v1
-- Multi-tenant: every business table carries chamber_id (tenant key).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── Tenancy & people ─────────────────────────
CREATE TABLE chambers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  province     text NOT NULL,
  logo_url     text,
  phone        text,
  email        text,
  address      text,
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Person + login account. A person may exist without the ability to log in.
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id     uuid REFERENCES chambers(id),      -- home chamber (null for super admins)
  full_name      text NOT NULL,
  national_id    text,
  mobile         text,
  email          text,
  organization   text,                               -- شرکت/سازمان
  job_title      text,
  bio            text,                               -- سوابق
  password_hash  text,
  is_super_admin boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  mfa_secret     text,
  mfa_enabled    boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_mobile_uq ON users (mobile) WHERE mobile IS NOT NULL;
CREATE INDEX users_chamber_idx ON users (chamber_id);

CREATE TABLE chamber_admins (
  chamber_id uuid NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chamber_id, user_id)
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  device      text,
  ip          text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_token  text NOT NULL UNIQUE,
  platform    text NOT NULL,
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Structure ─────────────────────────
CREATE TABLE terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id  uuid NOT NULL REFERENCES chambers(id),
  number      int  NOT NULL,
  title       text NOT NULL,
  start_date  date NOT NULL,
  end_date    date,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chamber_id, number)
);
-- at most one active term per chamber
CREATE UNIQUE INDEX terms_one_active ON terms (chamber_id) WHERE status = 'active';

CREATE TABLE commissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id  uuid NOT NULL REFERENCES chambers(id),
  term_id     uuid NOT NULL REFERENCES terms(id),
  name        text NOT NULL,
  code        text NOT NULL,
  domain      text,                                  -- حوزه تخصصی
  description text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','dissolved')),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,    -- CommissionSettings (quorum, voting...)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term_id, code)
);
CREATE INDEX commissions_chamber_idx ON commissions (chamber_id);

-- History is never deleted: ending a position sets end_date/status and a new row is created.
CREATE TABLE commission_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id    uuid NOT NULL REFERENCES chambers(id),
  commission_id uuid NOT NULL REFERENCES commissions(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  position      text NOT NULL CHECK (position IN ('chair','vice_chair','secretary','member','expert','observer')),
  has_vote      boolean NOT NULL,
  start_date    date NOT NULL DEFAULT current_date,
  end_date      date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_one_active ON commission_memberships (commission_id, user_id) WHERE status = 'active';
CREATE UNIQUE INDEX memberships_one_chair ON commission_memberships (commission_id, position)
  WHERE status = 'active' AND position IN ('chair','vice_chair','secretary');
CREATE INDEX memberships_user_idx ON commission_memberships (user_id) WHERE status = 'active';

-- ───────────────────────── Issues & expert referrals ─────────────────────────
CREATE TABLE issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id    uuid NOT NULL REFERENCES chambers(id),
  commission_id uuid NOT NULL REFERENCES commissions(id),
  title         text NOT NULL,
  description   text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','on_agenda','resolved','closed')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Meetings ─────────────────────────
CREATE TABLE meetings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id       uuid NOT NULL REFERENCES chambers(id),
  commission_id    uuid NOT NULL REFERENCES commissions(id),
  number           int  NOT NULL,
  title            text NOT NULL,
  scheduled_at     timestamptz NOT NULL,
  duration_minutes int NOT NULL DEFAULT 90,
  location         text,
  online_link      text,
  type             text NOT NULL DEFAULT 'in_person' CHECK (type IN ('in_person','online','hybrid')),
  status           text NOT NULL DEFAULT 'draft',
  cancel_reason    text,
  checkin_closed_at timestamptz,
  started_at       timestamptz,
  started_by       uuid REFERENCES users(id),
  ended_at         timestamptz,
  ended_by         uuid REFERENCES users(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commission_id, number)
);
CREATE INDEX meetings_chamber_time_idx ON meetings (chamber_id, scheduled_at);

-- Snapshot of who is invited and whether they may vote in this meeting.
CREATE TABLE meeting_invitees (
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('chair','vice_chair','secretary','member','expert','observer','guest')),
  has_vote    boolean NOT NULL DEFAULT false,
  invited_at  timestamptz,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX invitees_user_idx ON meeting_invitees (user_id);

CREATE TABLE agenda_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id         uuid NOT NULL REFERENCES chambers(id),
  meeting_id         uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  issue_id           uuid REFERENCES issues(id),
  order_no           int  NOT NULL,
  title              text NOT NULL,
  description        text,
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  duration_minutes   int,
  presenter_id       uuid REFERENCES users(id),
  presenter_name     text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','done','referred','removed')),
  discussion_summary text,
  decision           text,
  proposed_resolution text,
  started_at         timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agenda_meeting_idx ON agenda_items (meeting_id, order_no);

CREATE TABLE referrals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id     uuid NOT NULL REFERENCES chambers(id),
  commission_id  uuid NOT NULL REFERENCES commissions(id),
  issue_id       uuid REFERENCES issues(id),
  agenda_item_id uuid REFERENCES agenda_items(id),
  expert_id      uuid NOT NULL REFERENCES users(id),
  request        text NOT NULL,
  response       text,
  due_date       date,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','cancelled')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  answered_at    timestamptz
);

CREATE TABLE attendance (
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','present','online','proxy','manual_present','absent','excused')),
  method        text CHECK (method IN ('app','web','manual','online')),
  checked_in_at timestamptz,
  proxy_name    text,
  note          text,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id     uuid NOT NULL REFERENCES chambers(id),
  agenda_item_id uuid NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vote_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id     uuid NOT NULL REFERENCES chambers(id),
  meeting_id     uuid NOT NULL REFERENCES meetings(id),
  agenda_item_id uuid NOT NULL REFERENCES agenda_items(id),
  title          text NOT NULL,
  secret         boolean NOT NULL DEFAULT false,
  options        jsonb NOT NULL DEFAULT '["yes","no","abstain"]'::jsonb,
  pass_rule      text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  opened_by      uuid REFERENCES users(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_by      uuid REFERENCES users(id),
  closed_at      timestamptz,
  result         jsonb
);
CREATE UNIQUE INDEX vote_sessions_one_open ON vote_sessions (agenda_item_id) WHERE status = 'open';

-- voter_id is kept for duplicate prevention and audit even for secret ballots;
-- the API never exposes it for secret sessions.
CREATE TABLE votes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_session_id uuid NOT NULL REFERENCES vote_sessions(id),
  voter_id        uuid NOT NULL REFERENCES users(id),
  choice          text NOT NULL,
  is_valid        boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_session_id, voter_id)
);

CREATE TABLE minutes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id     uuid NOT NULL REFERENCES chambers(id),
  meeting_id     uuid NOT NULL UNIQUE REFERENCES meetings(id),
  minutes_number text,
  version        int  NOT NULL DEFAULT 1,
  body           text NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','returned','approved')),
  return_reason  text,
  submitted_at   timestamptz,
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  content_hash   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE minutes_versions (
  minutes_id uuid NOT NULL REFERENCES minutes(id) ON DELETE CASCADE,
  version    int  NOT NULL,
  body       text NOT NULL,
  edited_by  uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (minutes_id, version)
);

-- ───────────────────────── Resolutions & follow-up ─────────────────────────
CREATE TABLE resolutions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id     uuid NOT NULL REFERENCES chambers(id),
  commission_id  uuid NOT NULL REFERENCES commissions(id),
  meeting_id     uuid REFERENCES meetings(id),
  agenda_item_id uuid REFERENCES agenda_items(id),
  vote_session_id uuid REFERENCES vote_sessions(id),
  number         text NOT NULL,
  text           text NOT NULL,
  owner_id       uuid REFERENCES users(id),        -- مسئول اجرا
  addressee      text,                             -- دستگاه/مخاطب
  due_date       date,
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  kpi            text,                             -- شاخص نتیجه
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','submitted','done','returned','cancelled')),
  progress       int  NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  due_soon_notified_at timestamptz,
  overdue_notified_at  timestamptz,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commission_id, number)
);
CREATE INDEX resolutions_owner_idx ON resolutions (owner_id);
CREATE INDEX resolutions_due_idx ON resolutions (due_date) WHERE status NOT IN ('done','cancelled');

CREATE TABLE resolution_updates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id uuid NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('progress','approve','return','comment')),
  progress      int,
  note          text,
  document_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id    uuid NOT NULL REFERENCES chambers(id),
  resolution_id uuid REFERENCES resolutions(id) ON DELETE CASCADE,
  title         text NOT NULL,
  assignee_id   uuid REFERENCES users(id),
  due_date      date,
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  output        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Documents ─────────────────────────
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id      uuid NOT NULL REFERENCES chambers(id),
  commission_id   uuid REFERENCES commissions(id),
  meeting_id      uuid REFERENCES meetings(id),
  agenda_item_id  uuid REFERENCES agenda_items(id),
  resolution_id   uuid REFERENCES resolutions(id),
  issue_id        uuid REFERENCES issues(id),
  kind            text NOT NULL DEFAULT 'attachment',   -- attachment | letter | report | minutes
  title           text,
  file_name       text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  storage_key     text NOT NULL,
  sha256          text NOT NULL,
  scan_status     text NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('pending','clean','infected')),
  owner_id        uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Notifications ─────────────────────────
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id  uuid REFERENCES chambers(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels    text[] NOT NULL,
  delivery    jsonb NOT NULL DEFAULT '{}'::jsonb,     -- channel → sent|failed|skipped
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ───────────────────────── Audit log (append-only, hash-chained) ─────────────────────────
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  chamber_id  uuid,
  user_id     uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  reason      text,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash   text,
  hash        text NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_logs (entity, entity_id);
CREATE INDEX audit_chamber_idx ON audit_logs (chamber_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Approved minutes are locked: no further change of content.
CREATE OR REPLACE FUNCTION minutes_lock() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'approved minutes are locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER minutes_locked BEFORE UPDATE ON minutes FOR EACH ROW EXECUTE FUNCTION minutes_lock();
