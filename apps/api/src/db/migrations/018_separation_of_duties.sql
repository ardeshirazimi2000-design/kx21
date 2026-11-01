-- Separation of duties (AFTA: system administration, security audit and the business processes are held by different
-- people). Alongside the system's IT administrator (users.is_super_admin) and the chamber administrators
-- (chamber_admins, who run the chamber's processes):
--   it_admin  (per chamber)          logins, passwords and roles of a chamber's people, API keys
--   auditor   (per chamber, or all)  reads the audit log, and nothing else; never also an administrator
--   national  (whole system)         Iran Chamber's secretariat: sees every chamber's commissions, runs the networks
CREATE TABLE staff_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('it_admin', 'auditor', 'national')),
  chamber_id  uuid REFERENCES chambers(id) ON DELETE CASCADE,
  granted_by  uuid,                                  -- no foreign key: kept when that account is removed
  granted_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'national' OR chamber_id IS NULL),
  CHECK (role <> 'it_admin' OR chamber_id IS NOT NULL)
);
CREATE UNIQUE INDEX staff_roles_unique ON staff_roles (user_id, role, COALESCE(chamber_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX staff_roles_user_idx ON staff_roles (user_id);

-- What each existing account could do is kept; the IT administrator then hands the roles to separate people.
INSERT INTO staff_roles (user_id, role, chamber_id) SELECT user_id, 'it_admin', chamber_id FROM chamber_admins;
INSERT INTO staff_roles (user_id, role) SELECT id, 'national' FROM users WHERE is_super_admin;
INSERT INTO chamber_admins (chamber_id, user_id) SELECT c.id, u.id FROM users u CROSS JOIN chambers c WHERE u.is_super_admin ON CONFLICT DO NOTHING;
