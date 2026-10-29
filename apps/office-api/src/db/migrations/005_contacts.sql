-- External contacts directory (مخاطبین بیرونی): organisations → units → positions, picked as the sender of incoming
-- letters and the recipient of outgoing ones instead of typing them. The letter keeps the composed text too (search,
-- print, older letters), so renaming a contact later does not rewrite letters already registered.

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES contacts(id),
  kind        text NOT NULL CHECK (kind IN ('organization','unit','position')),
  name        text NOT NULL,                     -- organisation / unit name, or the position's title
  person_name text,                              -- position holder (e.g. «جناب آقای …»)
  phone       text,
  email       text,
  address     text,
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'organization') = (parent_id IS NULL))
);
CREATE INDEX contacts_parent_idx ON contacts (parent_id);
CREATE UNIQUE INDEX contacts_name_uq ON contacts (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, fa_normalize(name), coalesce(fa_normalize(person_name), ''));

ALTER TABLE letters ADD COLUMN contact_id uuid REFERENCES contacts(id);
CREATE INDEX letters_contact_idx ON letters (contact_id);

-- Start the directory from the organisations already typed on letters (letters themselves stay as they are).
INSERT INTO contacts (kind, name)
SELECT DISTINCT ON (fa_normalize(btrim(external_org))) 'organization', btrim(external_org) FROM letters
 WHERE kind IN ('incoming','outgoing') AND coalesce(btrim(external_org), '') <> '' ORDER BY fa_normalize(btrim(external_org)), created_at;

-- Roles that register letters may maintain the directory.
INSERT INTO permissions (key, name, module) VALUES ('contacts.manage', 'مدیریت مخاطبین بیرونی', 'مکاتبات') ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT DISTINCT role_id, 'contacts.manage' FROM role_permissions WHERE permission_key IN ('letter.register_incoming','letter.register_outgoing') ON CONFLICT DO NOTHING;
