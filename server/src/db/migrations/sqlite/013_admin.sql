-- Admin panel (docs/ADMIN.md, ADR 0021): platform administrators, workspace suspension, impersonation sessions, feature flags, announcements.
CREATE TABLE platform_admins (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('bootstrap', 'admin')),
  added_by TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE workspaces ADD COLUMN suspended_at TEXT;
ALTER TABLE workspaces ADD COLUMN suspended_reason TEXT;
ALTER TABLE workspaces ADD COLUMN suspended_by TEXT;

-- A session opened by a platform administrator on behalf of a user ("support access"): no refresh token, short expiry.
ALTER TABLE sessions ADD COLUMN impersonator_id TEXT;

CREATE TABLE feature_flags (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  default_enabled INTEGER NOT NULL DEFAULT 0,
  rollout_percent INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE feature_flag_overrides (
  flag_key TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flag_key, workspace_id)
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE announcement_dismissals (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX idx_audit_action ON audit_log(action, created_at);
