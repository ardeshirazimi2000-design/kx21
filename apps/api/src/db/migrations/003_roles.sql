-- Configurable roles & permissions per chamber.

-- Custom roles defined by a chamber admin (usable as commission positions and meeting roles).
CREATE TABLE custom_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id  uuid NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
  key         text NOT NULL,
  title       text NOT NULL,
  description text,
  has_vote    boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chamber_id, key),
  UNIQUE (chamber_id, title)
);

-- Capability set of a role in a chamber. No row = the built-in default of that role.
CREATE TABLE role_permissions (
  chamber_id   uuid NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
  role_key     text NOT NULL,
  capabilities text[] NOT NULL,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chamber_id, role_key)
);

-- Positions / meeting roles are validated by the API against built-in + custom roles.
ALTER TABLE commission_memberships DROP CONSTRAINT IF EXISTS commission_memberships_position_check;
ALTER TABLE meeting_invitees DROP CONSTRAINT IF EXISTS meeting_invitees_role_check;
