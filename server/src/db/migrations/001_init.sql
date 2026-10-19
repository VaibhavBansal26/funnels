-- Funnels schema. Every business table carries workspace_id; repositories always filter on it.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  allow_custom_scripts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_users_workspace ON users(workspace_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name_lower)
);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  verification_token TEXT NOT NULL,
  failure_reason TEXT,
  default_home_step_id TEXT,
  default_404_step_id TEXT,
  verified_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_domains_workspace ON domains(workspace_id);

CREATE TABLE funnels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'test' CHECK (status IN ('live', 'test')),
  favicon TEXT,
  header_tracking_code TEXT,
  footer_tracking_code TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_funnels_workspace ON funnels(workspace_id, deleted_at, updated_at);
CREATE INDEX idx_funnels_domain ON funnels(domain_id);

CREATE TABLE funnel_tags (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (funnel_id, tag_id)
);
CREATE INDEX idx_funnel_tags_tag ON funnel_tags(tag_id);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT,
  seo_description TEXT,
  custom_css TEXT,
  header_tracking_code TEXT,
  footer_tracking_code TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (funnel_id, path_key)
);
CREATE INDEX idx_steps_funnel ON steps(funnel_id, position);

-- Source of truth is doc_json; html is the cached render; checksum identifies the html.
CREATE TABLE step_pages (
  step_id TEXT PRIMARY KEY REFERENCES steps(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  funnel_id TEXT NOT NULL,
  doc_json TEXT NOT NULL,
  html TEXT NOT NULL,
  checksum TEXT NOT NULL,
  -- 1 when the last save came from an owner with allowCustomScripts on; controls <script> in custom HTML blocks.
  scripts_ok INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE step_backups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  funnel_id TEXT NOT NULL,
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  doc_json TEXT NOT NULL,
  html TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_backups_step ON step_backups(step_id, created_at);

-- Global (workspace-less) templates.
CREATE TABLE template_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES template_categories(id) ON DELETE SET NULL,
  base_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE template_steps (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  position INTEGER NOT NULL,
  doc_json TEXT NOT NULL
);
CREATE INDEX idx_template_steps ON template_steps(template_id, position);

CREATE TABLE custom_blocks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  block_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_custom_blocks_workspace ON custom_blocks(workspace_id);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  first_funnel_id TEXT,
  submissions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, email)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  lead_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  product_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  is_bump INTEGER NOT NULL DEFAULT 0,
  is_upsell INTEGER NOT NULL DEFAULT 0,
  parent_order_id TEXT,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  payment_method_ref TEXT,
  idem_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_orders_idem ON orders(funnel_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_orders_workspace ON orders(workspace_id, created_at);
CREATE INDEX idx_orders_funnel ON orders(funnel_id, created_at);

-- One table, three explicit event types (the legacy product overloaded a single row shape).
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('page_view', 'optin', 'order')),
  visitor_id TEXT,
  unique_visit INTEGER NOT NULL DEFAULT 0,
  lead_id TEXT,
  order_id TEXT,
  external_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  utm_json TEXT,
  url TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_events_dedupe ON events(funnel_id, type, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_events_funnel_time ON events(funnel_id, created_at);
CREATE INDEX idx_events_step_type ON events(funnel_id, step_id, type);
CREATE INDEX idx_events_visitor ON events(funnel_id, step_id, visitor_id);
CREATE INDEX idx_events_lead ON events(lead_id);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webhooks_workspace ON webhooks(workspace_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);

-- Small durable queue polled by the in-process worker.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  locked_at INTEGER,
  dedupe_key TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, run_at);
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'queued';

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_workspace ON notifications(workspace_id, created_at);

CREATE TABLE ai_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
