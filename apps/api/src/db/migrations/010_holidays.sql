-- Holidays (تعطیلات): defined by the Super Admin for the whole country (chamber_id NULL) or by a chamber admin
-- for one province, plus a cache of the official calendar web service (s.api.ir IsHoliday).
CREATE TABLE holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id  uuid REFERENCES chambers(id) ON DELETE CASCADE,
  date        date NOT NULL,
  title       text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (chamber_id, date)
);
CREATE INDEX holidays_date_idx ON holidays (date);

CREATE TABLE holiday_lookups (
  date        date PRIMARY KEY,
  is_holiday  boolean NOT NULL,
  title       text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
