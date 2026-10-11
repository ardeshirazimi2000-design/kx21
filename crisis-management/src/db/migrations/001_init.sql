-- سامانه مدیریت بحران شهری — schema: identity, RBAC, sessions, OTP, Shahkar log, audit, operations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Municipal districts (مناطق شهرداری). Used for district-scoped roles.
CREATE TABLE districts (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  name       text NOT NULL
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  national_code         text NOT NULL UNIQUE,
  mobile                text NOT NULL,
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  -- staff: created in the console by a user administrator; citizen: self-enrolled from the app.
  kind                  text NOT NULL CHECK (kind IN ('staff', 'citizen')),
  organization          text,
  position_title        text,
  district_id           integer REFERENCES districts(id),
  -- Console sign-in (staff only): username + password + SMS OTP.
  username              text UNIQUE,
  password_hash         text,
  password_changed_at   timestamptz,
  must_change_password  boolean NOT NULL DEFAULT false,
  console_access        boolean NOT NULL DEFAULT false,
  app_access            boolean NOT NULL DEFAULT true,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  -- Shahkar (national code ↔ SIM owner match) state.
  shahkar_verified_at   timestamptz,
  -- Set after the first successful app sign-in (Shahkar + OTP). Later app sign-ins use OTP only.
  app_enrolled_at       timestamptz,
  last_login_at         timestamptz,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_mobile_idx ON users (mobile);

CREATE TABLE roles (
  key          text PRIMARY KEY,
  title        text NOT NULL UNIQUE,
  description  text,
  -- city: whole city; district: only the user's district; own: only records assigned to/created by the user.
  scope        text NOT NULL CHECK (scope IN ('city', 'district', 'own')),
  builtin      boolean NOT NULL DEFAULT false,
  -- Locked roles (security administration / audit) cannot be edited from the console.
  locked       boolean NOT NULL DEFAULT false,
  -- Roles that may only be held by staff accounts.
  staff_only   boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_key    text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission  text NOT NULL,
  PRIMARY KEY (role_key, permission)
);

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key    text NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  -- Optional time-bound grant (e.g. temporary role during an emergency).
  expires_at  timestamptz,
  PRIMARY KEY (user_id, role_key)
);

CREATE TABLE password_history (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_history_user_idx ON password_history (user_id, created_at DESC);

-- Pending authentication challenges (one per login attempt). OTP codes are stored as HMAC only.
CREATE TABLE auth_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('console', 'app')),
  -- console_login | app_enroll (first login, Shahkar passed) | app_login (OTP only) | app_signup (new citizen)
  purpose       text NOT NULL,
  mobile        text NOT NULL,
  national_code text,
  pending_profile jsonb,
  code_hash     text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  ip            text,
  device_id     text,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_mobile_idx ON auth_challenges (mobile, created_at DESC);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('console', 'app')),
  refresh_hash        text NOT NULL,
  device_id           text,
  device_name         text,
  ip                  text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_reason      text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- App devices of a user. A sign-in from a device not seen before counts as an initial sign-in (Shahkar again).
CREATE TABLE user_devices (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  device_name   text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  PRIMARY KEY (user_id, device_id)
);

-- Every Shahkar inquiry (who asked, for whom, result). National code / mobile are stored masked.
CREATE TABLE shahkar_inquiries (
  id              bigserial PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  context         text NOT NULL,
  national_code_masked text NOT NULL,
  mobile_masked   text NOT NULL,
  endpoint        text NOT NULL,
  matched         boolean,
  success         boolean NOT NULL,
  provider_code   text,
  provider_message text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Append-only security audit trail.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  outcome     text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'denied')),
  ip          text,
  channel     text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC);

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ───── Operations ─────

CREATE TABLE incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  -- fire | flood | earthquake | building_collapse | gas_leak | storm | accident | other
  type          text NOT NULL,
  severity      integer NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 4),
  -- reported → verified → active (declared) → contained → closed ; rejected
  status        text NOT NULL DEFAULT 'reported'
                  CHECK (status IN ('reported', 'verified', 'active', 'contained', 'closed', 'rejected')),
  description   text,
  district_id   integer REFERENCES districts(id),
  address       text,
  lat           double precision,
  lng           double precision,
  source        text NOT NULL DEFAULT 'operator' CHECK (source IN ('operator', 'citizen', 'responder')),
  reported_by   uuid REFERENCES users(id),
  declared_by   uuid REFERENCES users(id),
  declared_at   timestamptz,
  closed_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_district_idx ON incidents (district_id, created_at DESC);

CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title         text NOT NULL,
  assignee_id   uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'assigned'
                  CHECK (status IN ('assigned', 'accepted', 'en_route', 'on_site', 'done', 'cancelled')),
  note          text,
  assigned_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  body          text NOT NULL,
  level         text NOT NULL CHECK (level IN ('info', 'warning', 'danger')),
  district_id   integer REFERENCES districts(id),
  incident_id   uuid REFERENCES incidents(id),
  published_by  uuid NOT NULL REFERENCES users(id),
  published_at  timestamptz NOT NULL DEFAULT now()
);
