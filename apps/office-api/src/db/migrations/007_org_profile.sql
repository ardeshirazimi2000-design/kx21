-- Organisation profile (مشخصات سازمان) and generic meeting wording, so any organisation can run the system.

-- One row: the organisation's name and logo, shown on the login page, the public verification page and as the
-- letterhead default. builtin_logo names a logo shipped with the web app (used until an image is uploaded).
CREATE TABLE org_profile (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  name          text NOT NULL DEFAULT '',
  short_name    text,
  logo_key      text,
  logo_mime     text,
  builtin_logo  text CHECK (builtin_logo IN ('chamber')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- An existing installation (anybody besides the system account) keeps the name and logo it showed until now;
-- a new one starts empty and its administrator fills the profile in.
INSERT INTO org_profile (name, builtin_logo)
SELECT 'اتاق بازرگانی، صنایع، معادن و کشاورزی ایران', 'chamber'
 WHERE EXISTS (SELECT 1 FROM users WHERE username <> 'system');
INSERT INTO org_profile (name) VALUES ('') ON CONFLICT (id) DO NOTHING;

-- A new installation's default letterhead takes the organisation's name from the profile (an empty org_name does).
UPDATE letter_templates SET name = 'سربرگ رسمی', org_name = NULL
 WHERE is_default AND name = 'سربرگ رسمی اتاق' AND NOT EXISTS (SELECT 1 FROM users WHERE username <> 'system');

-- Built-in names that still carry the old wording (names someone changed are kept).
UPDATE workflow_definitions SET name = 'پیگیری اجرای مصوبه جلسه' WHERE key = 'resolution-followup' AND name = 'پیگیری اجرای مصوبه کمیسیون';
UPDATE integrations SET name = 'سامانه جلسات' WHERE kind = 'meetings' AND name = 'سامانه جلسات کمیسیون‌ها';
UPDATE roles SET name = 'رئیس سازمان / معاون' WHERE key = 'president' AND name = 'رئیس اتاق / معاون';
