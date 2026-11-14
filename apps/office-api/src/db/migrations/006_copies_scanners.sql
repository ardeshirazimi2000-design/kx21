-- Copies (رونوشت) and delivery of internal letters, and network scanners for attachments.

-- Internal recipients (to / cc) are handed over through the cartable: «گیرنده» for action, «رونوشت» for information.
-- delivered_at marks the recipients already handed over, so editing a registered letter only delivers the new ones.
ALTER TABLE letter_recipients ADD COLUMN note text;
ALTER TABLE letter_recipients ADD COLUMN delivered_at timestamptz;
ALTER TABLE letter_recipients ADD COLUMN sort int NOT NULL DEFAULT 0;
-- Letters registered before this migration were already announced to their recipients.
UPDATE letter_recipients lr SET delivered_at = l.registered_at FROM letters l WHERE l.id = lr.letter_id AND l.number IS NOT NULL;

-- Copies of an outgoing letter to other organisations (رونوشت بیرونی): a contact from the directory or a typed name.
-- The label keeps the composed text, as letters do, so renaming a contact does not rewrite a letter.
CREATE TABLE letter_external_copies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id   uuid NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id),
  label       text NOT NULL,
  note        text,
  sort        int NOT NULL DEFAULT 0
);
CREATE INDEX letter_external_copies_letter_idx ON letter_external_copies (letter_id);

-- Network scanners reached by the server over eSCL (AirScan); USB scanners can be shared through an eSCL bridge.
CREATE TABLE scanners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  url          text NOT NULL,              -- eSCL root, e.g. http://192.168.1.40/eSCL
  location     text,
  is_active    boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
