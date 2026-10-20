-- Platform roles and read-only support access (docs/ADMIN.md): 'support' administrators can only open read-only impersonation sessions; 'superadmin' can also enable writes.
-- Existing administrators from PLATFORM_ADMIN_EMAILS (bootstrap) become superadmins, everyone added through the API becomes 'support' (least privilege).
ALTER TABLE platform_admins ADD COLUMN role TEXT NOT NULL DEFAULT 'support' CHECK (role IN ('support', 'superadmin'));
UPDATE platform_admins SET role = 'superadmin' WHERE source = 'bootstrap';

-- Support sessions are read-only unless the administrator asked for writes (superadmin and a reason are required to do so).
ALTER TABLE sessions ADD COLUMN allow_writes INTEGER NOT NULL DEFAULT 0;
