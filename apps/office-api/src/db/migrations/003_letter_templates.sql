-- Letter templates (قالب و سربرگ نامه), rich-text letter bodies, a designated signatory, and
-- signatures that no longer cover the indicator number (so a letter can be signed before it is numbered).

CREATE TABLE letter_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  description     text,
  kinds           text[] NOT NULL DEFAULT '{outgoing,internal}',
  unit_id         uuid REFERENCES org_units(id),          -- null: every unit
  page_size       text NOT NULL DEFAULT 'A4' CHECK (page_size IN ('A4','A5')),
  header_text     text,                                     -- e.g. «بسمه تعالی»
  org_name        text,
  org_subtitle    text,
  footer_text     text,                                     -- address, phone, website
  show_logo       boolean NOT NULL DEFAULT true,
  logo_key        text,
  logo_mime       text,
  background_key  text,                                     -- full-page scanned letterhead (replaces the drawn header)
  background_mime text,
  margin_top      int NOT NULL DEFAULT 15 CHECK (margin_top BETWEEN 0 AND 120),
  margin_bottom   int NOT NULL DEFAULT 15 CHECK (margin_bottom BETWEEN 0 AND 120),
  margin_side     int NOT NULL DEFAULT 18 CHECK (margin_side BETWEEN 0 AND 60),
  font_size       numeric(4,1) NOT NULL DEFAULT 13 CHECK (font_size BETWEEN 8 AND 24),
  show_qr         boolean NOT NULL DEFAULT true,
  body_html       text,                                     -- starting text for a new letter
  is_default      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX letter_templates_one_default ON letter_templates (is_default) WHERE is_default;

INSERT INTO letter_templates (name, description, header_text, org_name, org_subtitle, footer_text, body_html, is_default)
VALUES ('سربرگ رسمی اتاق', 'قالب پیش‌فرض نامه‌های صادره و داخلی', 'بسمه تعالی', 'اتاق بازرگانی، صنایع، معادن و کشاورزی ایران', NULL,
        'نشانی و تلفن را در «مکاتبات ← قالب‌های نامه» وارد کنید.', '<p>با سلام و احترام،</p><p></p>', true);

ALTER TABLE letters
  ADD COLUMN template_id  uuid REFERENCES letter_templates(id) ON DELETE SET NULL,
  ADD COLUMN body_format  text NOT NULL DEFAULT 'text' CHECK (body_format IN ('text','html')),
  ADD COLUMN signatory_id uuid REFERENCES users(id);         -- امضاکننده تعیین‌شده

-- Search ignores HTML markup in rich-text bodies.
ALTER TABLE letters DROP COLUMN search;
ALTER TABLE letters ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', fa_normalize(coalesce(number,'') || ' ' || coalesce(subject,'') || ' ' ||
    regexp_replace(coalesce(body,''), '<[^>]*>|&nbsp;', ' ', 'g') || ' ' ||
    coalesce(external_party,'') || ' ' || coalesce(external_org,'') || ' ' || coalesce(external_number,'') || ' ' || tracking_code))
) STORED;
CREATE INDEX letters_search_idx ON letters USING gin (search);

-- 1: hash includes the indicator number (signatures made before this migration); 2: it does not.
ALTER TABLE signatures ADD COLUMN hash_version int NOT NULL DEFAULT 1;

INSERT INTO permissions (key, name, module) VALUES ('templates.manage', 'مدیریت قالب‌ها و سربرگ نامه', 'مکاتبات')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key) SELECT id, 'templates.manage' FROM roles WHERE key IN ('admin', 'secretariat')
  ON CONFLICT DO NOTHING;
