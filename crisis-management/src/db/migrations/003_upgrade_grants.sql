-- Upgrades from v1.0: built-in operational roles that already exist receive the new export permission.
-- (Fresh installs get it from the role catalogue; locked security roles are re-synchronised at start-up.)
INSERT INTO role_permissions (role_key, permission)
SELECT r.key, 'data.export' FROM roles r WHERE r.key IN ('crisis_director', 'operations_chief')
ON CONFLICT DO NOTHING;
