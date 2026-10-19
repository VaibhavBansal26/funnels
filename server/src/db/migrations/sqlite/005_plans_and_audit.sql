-- Plan tier and per-workspace rate-limit override (docs/RATE-LIMITING.md), and an audit trail for operator actions.
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business'));
ALTER TABLE workspaces ADD COLUMN rate_override TEXT;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
