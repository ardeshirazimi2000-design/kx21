-- AFTA protection profile for network-based application software (PP v1.1): additions.

-- FMT_SMF / FMT_MOF: security settings managed at runtime by authorised administrators.
CREATE TABLE security_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- FAU_GEN.1.2 / FAU_SAR.3: richer audit records; FAU_STG.1.2 + FCS_COP.1(1): HMAC hash chain.
ALTER TABLE audit_log
  ADD COLUMN severity   text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  ADD COLUMN actor_name text,
  ADD COLUMN user_agent text,
  ADD COLUMN prev_hash  text,
  ADD COLUMN hash       text;
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);

-- Archiving (FAU_STG.4) is the only way rows may leave the trail: only inside audit_archive_purge().
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('crisis.audit_archive', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

-- Exports of the audit trail (FDP_ETC) and archive checkpoints that keep the hash chain verifiable.
CREATE TABLE audit_exports (
  id          bigserial PRIMARY KEY,
  from_id     bigint NOT NULL,
  to_id       bigint NOT NULL,
  row_count   integer NOT NULL,
  sha256      text NOT NULL,
  exported_by uuid NOT NULL REFERENCES users(id),
  exported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_archives (
  id            bigserial PRIMARY KEY,
  export_id     bigint NOT NULL REFERENCES audit_exports(id),
  last_id       bigint NOT NULL,
  last_hash     text NOT NULL,
  row_count     integer NOT NULL,
  archived_by   uuid NOT NULL REFERENCES users(id),
  archived_at   timestamptz NOT NULL DEFAULT now()
);

-- FAU_STG.3 / FDP_SDI.2.2 / FPT_FLS: notices for security administrators and auditors.
CREATE TABLE security_notifications (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message          text NOT NULL,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by  uuid REFERENCES users(id),
  acknowledged_at  timestamptz
);

-- FIA_AFL (progressive lockout), FTA_TAH (access history), FTA_TSE (per-user network restriction).
ALTER TABLE users
  ADD COLUMN lock_count           integer NOT NULL DEFAULT 0,
  ADD COLUMN last_login_ip        text,
  ADD COLUMN last_failed_login_at timestamptz,
  ADD COLUMN failed_since_success integer NOT NULL DEFAULT 0,
  ADD COLUMN allowed_cidrs        text[] NOT NULL DEFAULT '{}';

-- FMT_SMR.1.2 (application note 19): each user account is associated with exactly one role.
CREATE UNIQUE INDEX user_roles_one_role ON user_roles (user_id);

-- FIA_UAU.5: a server-issued secret proves possession of an enrolled device (OTP-only sign-in).
ALTER TABLE user_devices ADD COLUMN secret_hash text;

-- FIA_USB.1.3: session bound to the client it was issued to; FTA_TAH: history shown at sign-in.
ALTER TABLE sessions
  ADD COLUMN bound_ip       text,
  ADD COLUMN access_history jsonb;

-- FDP_SDI.2: integrity seal of incident records.
ALTER TABLE incidents
  ADD COLUMN integrity_mac text,
  ADD COLUMN integrity_ok  boolean NOT NULL DEFAULT true;
