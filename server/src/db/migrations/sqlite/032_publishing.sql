-- Publishing to Cloudflare Pages: encrypted credentials per workspace, the publish settings of a funnel and the deployment history.
CREATE TABLE IF NOT EXISTS publish_credentials (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  verified_at TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funnel_publish (
  funnel_id TEXT PRIMARY KEY REFERENCES funnels(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT 'origin' CHECK (target IN ('origin', 'cloudflare-pages')),
  owner TEXT NOT NULL DEFAULT 'workspace' CHECK (owner IN ('workspace', 'platform')),
  project_name TEXT,
  pages_host TEXT,
  active_deployment_id TEXT,
  active_version TEXT,
  custom_domain TEXT,
  custom_domain_status TEXT,
  custom_domain_error TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  project_created INTEGER NOT NULL DEFAULT 0,
  hold INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funnel_publish_ws ON funnel_publish(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_publish_platform_project ON funnel_publish(project_name) WHERE owner = 'platform' AND project_name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_publish_ws_project ON funnel_publish(workspace_id, project_name) WHERE owner = 'workspace' AND project_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS publish_deployments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  version_id TEXT,
  cf_deployment_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('publish', 'save', 'redeploy', 'rollback', 'unpublish')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'uploading', 'deploying', 'succeeded', 'failed', 'superseded', 'rolled_back')),
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  error TEXT,
  log_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_publish_deployments_funnel ON publish_deployments(funnel_id, created_at);
