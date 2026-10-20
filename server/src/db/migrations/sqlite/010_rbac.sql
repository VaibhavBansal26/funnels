-- RBAC (docs/RBAC.md, ADR 0018): custom roles, sessions with rotating refresh tokens, invitations, password reset, TOTP 2FA, richer audit log.
-- Built-in roles (owner, admin, member, viewer) live in code (auth/permissions.ts); users.role_id holds their id or a custom `roles.id`. The legacy
-- users.role column stays (it has a CHECK) and mirrors the built-in role, or 'member' for a custom/viewer role.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

ALTER TABLE users ADD COLUMN role_id TEXT;
UPDATE users SET role_id = role;
ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- One row per login on a device. The access token carries the session id; revoking the session ends it at once.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Refresh tokens rotate: each use marks the token used and issues the next. Presenting a used token again means it was stolen: the whole session is revoked.
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_refresh_session ON refresh_tokens(session_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_invitations_workspace ON invitations(workspace_id, created_at);
CREATE INDEX idx_invitations_email ON invitations(email);

CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_resets_user ON password_resets(user_id);

-- TOTP (RFC 6238). The secret is encrypted at rest (AES-256-GCM, key from DATA_ENCRYPTION_KEY or derived from JWT_SECRET). last_step blocks replay of a code.
CREATE TABLE user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  confirmed_at TEXT,
  last_step INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_recovery_user ON recovery_codes(user_id);

ALTER TABLE audit_log ADD COLUMN target TEXT;
ALTER TABLE audit_log ADD COLUMN ip TEXT;
CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at);
