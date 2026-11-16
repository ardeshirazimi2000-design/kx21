-- Telephony (Asterisk) part of the communications module.

-- The SIP password of each extension, encrypted with DATA_ENCRYPTION_KEY like other secrets. Rasa writes it only into
-- the PBX configuration volume; it is shown once to an extensions manager when (re)generated, never stored in the browser.
ALTER TABLE communication_extensions ADD COLUMN sip_secret_enc text;

-- One row per call (Asterisk linkedid). Numbers are kept as dialled; the user columns are resolved from extensions.
CREATE TABLE communication_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_call_id  text NOT NULL UNIQUE,                     -- Asterisk Linkedid
  direction       text NOT NULL CHECK (direction IN ('internal', 'inbound', 'outbound')),
  caller_number   text,
  caller_name     text,
  callee_number   text,
  caller_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  callee_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  started_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz,
  ended_at        timestamptz,
  disposition     text CHECK (disposition IN ('answered', 'missed', 'busy', 'failed')),
  duration_seconds int
);
CREATE INDEX communication_calls_started_idx ON communication_calls (started_at DESC);
CREATE INDEX communication_calls_caller_idx ON communication_calls (caller_user_id, started_at DESC);
CREATE INDEX communication_calls_callee_idx ON communication_calls (callee_user_id, started_at DESC);
CREATE INDEX communication_calls_numbers_idx ON communication_calls (caller_number, callee_number);

-- Minimal event trail of a call (no audio, no secrets). A repeated event (reconnect, replay) is ignored.
CREATE TABLE communication_call_events (
  id          bigserial PRIMARY KEY,
  call_id     uuid NOT NULL REFERENCES communication_calls(id) ON DELETE RESTRICT,
  event_type  text NOT NULL,
  event_key   text NOT NULL,                                 -- e.g. channel uniqueid: makes the event idempotent
  event_at    timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (call_id, event_type, event_key)
);

-- Module settings edited in Rasa (e.g. where calls from the city line ring).
CREATE TABLE communication_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
