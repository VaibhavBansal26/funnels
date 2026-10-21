-- Publish target 'cloudflare-workers-assets' (experimental): SQLite cannot change a CHECK constraint, so the table is rebuilt with the wider one.
CREATE TABLE funnel_publish_new (
  funnel_id TEXT PRIMARY KEY REFERENCES funnels(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT 'origin' CHECK (target IN ('origin', 'cloudflare-pages', 'cloudflare-workers-assets')),
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
INSERT INTO funnel_publish_new SELECT funnel_id, workspace_id, target, owner, project_name, pages_host, active_deployment_id, active_version, custom_domain, custom_domain_status, custom_domain_error, paused, project_created, hold, lease_until, last_error, created_at, updated_at FROM funnel_publish;
DROP TABLE funnel_publish;
ALTER TABLE funnel_publish_new RENAME TO funnel_publish;
CREATE INDEX IF NOT EXISTS idx_funnel_publish_ws ON funnel_publish(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_publish_platform_project ON funnel_publish(project_name) WHERE owner = 'platform' AND project_name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_publish_ws_project ON funnel_publish(workspace_id, project_name) WHERE owner = 'workspace' AND project_name IS NOT NULL;
