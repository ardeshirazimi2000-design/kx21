-- Communications module (ارتباطات سازمانی), first part: extensions registry and the organisational messenger.
-- People, units and positions are read from the existing users / org_units / positions tables; nothing is duplicated.
-- Telephony tables (calls, call events, queues, recordings) come with the PBX phase, once the PBX is decided.

-- An internal phone number assigned to a user. The number belongs to the person, not to the unit or position:
-- moving the person to another unit does not touch it. Rows are never deleted (history); they end as 'disabled'.
--   draft        recorded in Rasa, not yet on the PBX
--   provisioning the PBX adapter is creating it
--   active       exists on the PBX (created by the adapter or confirmed by hand by an administrator)
--   suspended    temporarily blocked
--   failed       provisioning failed (last_error holds a safe message)
--   disabled     retired; the number may be given to someone else
CREATE TABLE communication_extensions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  extension_number text NOT NULL CHECK (extension_number ~ '^[0-9]{2,6}$'),
  label            text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'provisioning', 'active', 'suspended', 'failed', 'disabled')),
  provision_source text CHECK (provision_source IN ('adapter', 'manual')),
  last_error       text,
  last_registered_at timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  disabled_at      timestamptz
);
-- One live holder per number on the PBX; a retired number can be reassigned.
CREATE UNIQUE INDEX communication_extensions_number_uq ON communication_extensions (extension_number) WHERE status <> 'disabled';
CREATE INDEX communication_extensions_user_idx ON communication_extensions (user_id);

-- A conversation: 'direct' between exactly two people (one per pair), or a 'group' with managed membership.
CREATE TABLE communication_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_type text NOT NULL CHECK (conversation_type IN ('direct', 'group')),
  title             text,
  description       text,
  -- direct only: "<smaller user id>:<larger user id>", so a pair never gets a second conversation
  direct_key        text UNIQUE,
  owner_unit_id     uuid REFERENCES org_units(id),
  is_archived       boolean NOT NULL DEFAULT false,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_message_at   timestamptz,
  CHECK ((conversation_type = 'direct') = (direct_key IS NOT NULL)),
  CHECK (conversation_type = 'direct' OR title IS NOT NULL)
);
CREATE INDEX communication_conversations_last_idx ON communication_conversations (last_message_at DESC NULLS LAST);

-- Membership. Leaving (or being removed) sets left_at: the member keeps no access, the history stays.
CREATE TABLE communication_conversation_members (
  conversation_id   uuid NOT NULL REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_role       text NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner', 'member')),
  joined_at         timestamptz NOT NULL DEFAULT now(),
  left_at           timestamptz,
  last_read_at      timestamptz,
  muted             boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX communication_members_user_idx ON communication_conversation_members (user_id) WHERE left_at IS NULL;

CREATE TABLE communication_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  sender_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,     -- null for system lines (member added, …)
  message_type     text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'file', 'system')),
  body             text NOT NULL DEFAULT '',
  -- the sender's own key for this message: a retried send returns the first message instead of a duplicate
  client_id        text,
  reply_to_id      uuid REFERENCES communication_messages(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  deleted_at       timestamptz
);
CREATE INDEX communication_messages_conv_idx ON communication_messages (conversation_id, created_at DESC);
CREATE UNIQUE INDEX communication_messages_client_uq ON communication_messages (sender_user_id, client_id) WHERE client_id IS NOT NULL;

-- Files are stored encrypted by lib/storage like letter attachments, and served only through the API to members.
CREATE TABLE communication_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES communication_messages(id) ON DELETE RESTRICT,
  file_name    text NOT NULL,
  storage_key  text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  checksum     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX communication_attachments_message_idx ON communication_attachments (message_id);
