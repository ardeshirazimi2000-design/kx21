-- Several executive bodies (دستگاه‌های اجرایی) per resolution: one lead and partners, each reporting its own progress.
-- resolutions.addressee keeps their names joined, for reports, letters and integrations.
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chamber_id  uuid NOT NULL REFERENCES chambers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chamber_id, name)
);

CREATE TABLE resolution_executors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id    uuid NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  role             text NOT NULL DEFAULT 'partner' CHECK (role IN ('lead','partner')),
  order_no         int  NOT NULL DEFAULT 0,
  progress         int  NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  last_report_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resolution_id, organization_id)
);
CREATE UNIQUE INDEX resolution_executors_one_lead ON resolution_executors (resolution_id) WHERE role = 'lead';

ALTER TABLE resolution_updates ADD COLUMN executor_id uuid REFERENCES resolution_executors(id) ON DELETE SET NULL;

-- Existing resolutions: their «دستگاه/مخاطب» becomes the lead body, with the resolution's progress.
INSERT INTO organizations (chamber_id, name)
SELECT DISTINCT chamber_id, btrim(addressee) FROM resolutions WHERE btrim(coalesce(addressee, '')) <> ''
ON CONFLICT DO NOTHING;
INSERT INTO resolution_executors (resolution_id, organization_id, role, progress, status)
SELECT r.id, o.id, 'lead', r.progress, CASE WHEN r.status = 'done' THEN 'done' WHEN r.progress > 0 THEN 'in_progress' ELSE 'open' END
  FROM resolutions r JOIN organizations o ON o.chamber_id = r.chamber_id AND o.name = btrim(r.addressee);
