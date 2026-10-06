-- Identity verification of people against the national identity inquiry service.
ALTER TABLE users
  ADD COLUMN first_name           text,
  ADD COLUMN last_name            text,
  ADD COLUMN father_name          text,
  ADD COLUMN birth_date_jalali    text,
  ADD COLUMN identity_verified_at timestamptz,
  ADD COLUMN identity_source      text,
  ADD COLUMN identity_data        jsonb;

-- The same national code may exist once per chamber (a person can belong to several chambers).
CREATE UNIQUE INDEX users_chamber_national_id_uq ON users (chamber_id, national_id) WHERE national_id IS NOT NULL;
