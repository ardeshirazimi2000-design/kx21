-- سامانه اتوماسیون اداری اتاق بازرگانی — schema v1 (see docs/office/02-database.md)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Persian text normalisation for search (Arabic yeh/kaf, ZWNJ, digits).
CREATE OR REPLACE FUNCTION fa_normalize(t text) RETURNS text AS $$
  SELECT translate(coalesce(t, ''), 'يكۀة' || chr(8204) || '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'یکهه 01234567890123456789');
$$ LANGUAGE sql IMMUTABLE;

-- ───────────────────────── Organisation (ساختار سازمانی) ─────────────────────────
CREATE TABLE org_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES org_units(id),
  name        text NOT NULL,
  code        text NOT NULL UNIQUE,
  kind        text NOT NULL DEFAULT 'department' CHECK (kind IN ('presidency','deputy','department','office','secretariat','committee')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES org_units(id),
  title       text NOT NULL,
  parent_id   uuid REFERENCES positions(id),          -- reports to (سلسله‌مراتب)
  is_manager  boolean NOT NULL DEFAULT false,         -- head of the unit
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX positions_unit_idx ON positions (unit_id);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL,
  full_name        text NOT NULL,
  national_id      text,
  email            text,
  mobile           text,
  password_hash    text,
  is_active        boolean NOT NULL DEFAULT true,
  clearance        int  NOT NULL DEFAULT 0 CHECK (clearance BETWEEN 0 AND 2),   -- 0 عادی، 1 محرمانه، 2 سری (ABAC)
  mfa_secret_enc   text,
  mfa_enabled      boolean NOT NULL DEFAULT false,
  sign_public_key  text,                               -- Ed25519 (SPKI PEM)
  sign_private_enc text,                               -- AES-256-GCM encrypted PKCS8 PEM
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_national_id_uq ON users (national_id) WHERE national_id IS NOT NULL;

CREATE TABLE user_positions (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  is_primary  boolean NOT NULL DEFAULT true,
  start_date  date NOT NULL DEFAULT current_date,
  end_date    date,
  PRIMARY KEY (user_id, position_id)
);
CREATE INDEX user_positions_position_idx ON user_positions (position_id) WHERE end_date IS NULL;

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key     text PRIMARY KEY,
  name    text NOT NULL,
  module  text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- scope_unit_id: the role applies to that unit and its sub-units only (null = whole organisation).
CREATE TABLE user_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_unit_id uuid REFERENCES org_units(id),
  UNIQUE NULLS NOT DISTINCT (user_id, role_id, scope_unit_id)
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

-- People of other systems (e.g. meeting participants) mapped to local users.
CREATE TABLE user_external_links (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  system       text NOT NULL,
  external_id  text NOT NULL,
  matched_by   text NOT NULL,                           -- national_id | email | mobile | manual
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, external_id)
);

-- ───────────────────────── Correspondence (مکاتبات) ─────────────────────────
CREATE TABLE number_sequences (
  kind      text NOT NULL,
  year      int  NOT NULL,
  last_seq  int  NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, year)
);

CREATE TABLE letters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('incoming','outgoing','internal')),
  number            text UNIQUE,                    -- شماره اندیکاتور (assigned on registration)
  year              int,
  seq               int,
  tracking_code     text NOT NULL UNIQUE,           -- barcode / QR
  subject           text NOT NULL,
  body              text,
  summary           text,
  -- incoming: external sender; outgoing: external recipient
  external_party    text,
  external_org      text,
  external_number   text,                           -- شماره نامه فرستنده (وارده)
  external_date     date,
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','email','scan','api','meeting')),
  delivery_method   text,                           -- پست، ایمیل، دستی، …
  priority          text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  confidentiality   int  NOT NULL DEFAULT 0 CHECK (confidentiality BETWEEN 0 AND 2),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','registered','in_progress','approved','signed','sent','archived','cancelled')),
  owner_unit_id     uuid REFERENCES org_units(id),
  signer_id         uuid REFERENCES users(id),
  reply_to_id       uuid REFERENCES letters(id),     -- پیرو / عطف
  due_date          date,
  registered_at     timestamptz,
  registered_by     uuid REFERENCES users(id),
  sent_at           timestamptz,
  archived_at       timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search            tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', fa_normalize(coalesce(number,'') || ' ' || coalesce(subject,'') || ' ' || coalesce(body,'') || ' ' ||
      coalesce(external_party,'') || ' ' || coalesce(external_org,'') || ' ' || coalesce(external_number,'') || ' ' || tracking_code))
  ) STORED
);
CREATE INDEX letters_search_idx ON letters USING gin (search);
CREATE INDEX letters_kind_idx ON letters (kind, created_at DESC);
CREATE INDEX letters_status_idx ON letters (status);
CREATE INDEX letters_owner_unit_idx ON letters (owner_unit_id);

-- Internal recipients (گیرندگان داخلی): a user, a position or a whole unit; to / cc.
CREATE TABLE letter_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id   uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id),
  position_id uuid REFERENCES positions(id),
  unit_id     uuid REFERENCES org_units(id),
  kind        text NOT NULL DEFAULT 'to' CHECK (kind IN ('to','cc')),
  CHECK (num_nonnulls(user_id, position_id, unit_id) = 1)
);
CREATE INDEX letter_recipients_letter_idx ON letter_recipients (letter_id);

-- Attachments with versioning: rows of the same group_id are versions of one attachment.
CREATE TABLE letter_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id    uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  group_id     uuid NOT NULL,
  version      int  NOT NULL DEFAULT 1,
  title        text,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  storage_key  text NOT NULL,
  sha256       text NOT NULL,
  source       text NOT NULL DEFAULT 'upload',      -- upload | scan | email | meeting
  external_ref text,
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, version)
);
CREATE INDEX letter_attachments_letter_idx ON letter_attachments (letter_id);

-- Routing / referral tree (ارجاع). Workflow steps also create routing rows so everything shows in the cartable.
CREATE TABLE letter_routing (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id         uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  parent_id         uuid REFERENCES letter_routing(id),
  from_user_id      uuid REFERENCES users(id),
  to_user_id        uuid REFERENCES users(id),
  to_position_id    uuid REFERENCES positions(id),
  action            text NOT NULL CHECK (action IN ('refer','review','approve','sign','archive','info','follow_up')),
  instruction       text,                              -- دستور/هامش
  due_at            timestamptz,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','seen','done','returned','cancelled')),
  response          text,
  workflow_step_id  uuid,
  seen_at           timestamptz,
  done_at           timestamptz,
  done_by           uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(to_user_id, to_position_id) = 1)
);
CREATE INDEX routing_to_user_idx ON letter_routing (to_user_id) WHERE status IN ('pending','seen');
CREATE INDEX routing_to_position_idx ON letter_routing (to_position_id) WHERE status IN ('pending','seen');
CREATE INDEX routing_letter_idx ON letter_routing (letter_id, created_at);

-- ───────────────────────── Workflow engine (گردش کار) ─────────────────────────
CREATE TABLE workflow_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  version     int  NOT NULL,
  name        text NOT NULL,
  description text,
  applies_to  text[] NOT NULL DEFAULT '{incoming,outgoing,internal}',
  definition  jsonb NOT NULL,                        -- { steps: [...] } (see services/workflow.ts)
  is_active   boolean NOT NULL DEFAULT true,         -- latest active version is used for new instances
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE workflow_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id    uuid NOT NULL REFERENCES workflow_definitions(id),
  letter_id        uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','rejected','cancelled')),
  current_step_key text,
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by       uuid REFERENCES users(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE UNIQUE INDEX workflow_one_running ON workflow_instances (letter_id) WHERE status = 'running';

CREATE TABLE workflow_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id         uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_key            text NOT NULL,
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN ('review','approve','sign','archive','notify')),
  seq                 int  NOT NULL,
  assignee_user_id    uuid REFERENCES users(id),
  assignee_position_id uuid REFERENCES positions(id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','approved','rejected','skipped','cancelled')),
  due_at              timestamptz,
  reminded_at         timestamptz,
  escalated_at        timestamptz,
  escalation_level    int NOT NULL DEFAULT 0,
  acted_by            uuid REFERENCES users(id),
  acted_at            timestamptz,
  comment             text,
  routing_id          uuid REFERENCES letter_routing(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_steps_active_idx ON workflow_steps (due_at) WHERE status = 'active';
ALTER TABLE letter_routing ADD CONSTRAINT routing_step_fk FOREIGN KEY (workflow_step_id) REFERENCES workflow_steps(id) ON DELETE SET NULL;

-- ───────────────────────── Archive (بایگانی و اسناد) ─────────────────────────
CREATE TABLE retention_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  retain_years  int  NOT NULL CHECK (retain_years >= 0),
  action        text NOT NULL DEFAULT 'review' CHECK (action IN ('destroy','review','permanent')),
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE archive_folders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id           uuid REFERENCES archive_folders(id),
  name                text NOT NULL,
  code                text,
  unit_id             uuid REFERENCES org_units(id),
  retention_policy_id uuid REFERENCES retention_policies(id),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id           uuid NOT NULL REFERENCES archive_folders(id),
  letter_id           uuid REFERENCES letters(id),
  title               text NOT NULL,
  description         text,
  doc_type            text NOT NULL DEFAULT 'general',
  confidentiality     int  NOT NULL DEFAULT 0 CHECK (confidentiality BETWEEN 0 AND 2),
  retention_policy_id uuid REFERENCES retention_policies(id),
  retention_until     date,
  legal_hold          boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed')),
  disposed_at         timestamptz,
  disposed_by         uuid REFERENCES users(id),
  dispose_reason      text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  search              tsvector GENERATED ALWAYS AS (to_tsvector('simple', fa_normalize(coalesce(title,'') || ' ' || coalesce(description,'')))) STORED
);
CREATE INDEX documents_folder_idx ON documents (folder_id);
CREATE INDEX documents_search_idx ON documents USING gin (search);
CREATE UNIQUE INDEX documents_letter_uq ON documents (letter_id) WHERE letter_id IS NOT NULL;

CREATE TABLE document_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version      int  NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  storage_key  text,                                 -- null after disposal
  sha256       text NOT NULL,
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

-- Digital signatures (Ed25519) over a content hash of a letter or a document version.
CREATE TABLE signatures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN ('letter','document_version')),
  entity_id     uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  position_title text,
  algorithm     text NOT NULL DEFAULT 'Ed25519',
  content_hash  text NOT NULL,
  signature     text NOT NULL,
  public_key    text NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signatures_entity_idx ON signatures (entity_type, entity_id);

-- ───────────────────────── Notifications & queue ─────────────────────────
CREATE TABLE notification_templates (
  event    text NOT NULL,
  channel  text NOT NULL CHECK (channel IN ('in_app','email','sms')),
  subject  text,
  body     text NOT NULL,
  enabled  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event, channel)
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Durable job queue (message queue) processed with SELECT … FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts    int  NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'queued';

-- ───────────────────────── Integration (یکپارچه‌سازی) ─────────────────────────
CREATE TABLE integrations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL UNIQUE CHECK (kind IN ('meetings','accounting','crm','government','intake')),
  name               text NOT NULL,
  base_url           text,
  client_id          text,
  client_secret_enc  text,                           -- API key of this system at the remote side (encrypted)
  webhook_secret_enc text,                           -- verifies inbound webhooks (encrypted)
  inbound_key_hash   text,                           -- for 'intake': API key that may post letters here
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  state              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. polling cursor
  is_active          boolean NOT NULL DEFAULT true,
  last_sync_at       timestamptz,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Inbound events, deduplicated by the sender's event id (idempotent processing).
CREATE TABLE integration_inbox (
  id           bigserial PRIMARY KEY,
  system       text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (system, event_id)
);

-- Local read model of the meetings system (نمای محلی).
CREATE TABLE meetings_cache (
  external_id      uuid PRIMARY KEY,
  commission_id    uuid,
  commission_name  text,
  number           int,
  title            text NOT NULL,
  scheduled_at     timestamptz,
  location         text,
  status           text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,    -- participants, agenda, documents, minutes
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_cache_time_idx ON meetings_cache (scheduled_at DESC);

CREATE TABLE resolutions_cache (
  external_id          uuid PRIMARY KEY,
  meeting_external_id  uuid REFERENCES meetings_cache(external_id),
  commission_name      text,
  number               text NOT NULL,
  text                 text NOT NULL,
  status               text NOT NULL,
  progress             int  NOT NULL DEFAULT 0,
  due_date             date,
  owner_name           text,
  owner_user_id        uuid REFERENCES users(id),     -- mapped local user (مسئول اجرا)
  letter_id            uuid REFERENCES letters(id),   -- letter created for the resolution
  data                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resolutions_cache_letter_idx ON resolutions_cache (letter_id);

-- Execution feedback sent back to the meetings system (پیگیری اجرای مصوبه).
CREATE TABLE resolution_feedback (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_external_id uuid NOT NULL REFERENCES resolutions_cache(external_id),
  letter_id             uuid REFERENCES letters(id),
  progress              int  NOT NULL,
  note                  text,
  submit                boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error                 text,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz
);

-- Letters referred to a commission / meeting (ارجاع مکاتبه به جلسه).
CREATE TABLE letter_meeting_refs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id          uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  commission_id      uuid NOT NULL,
  commission_name    text,
  requested_meeting_id uuid,
  external_issue_id  uuid NOT NULL UNIQUE,
  status             text NOT NULL,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Audit log (append-only, hash-chained) ─────────────────────────
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  user_id     uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  reason      text,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL,
  prev_hash   text,
  hash        text NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_logs (entity, entity_id);
CREATE INDEX audit_time_idx ON audit_logs (created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
