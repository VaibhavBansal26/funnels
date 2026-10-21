-- Free built-in addresses: every workspace has a public slug, every funnel a public slug, and domains get a kind.
--   kind 'custom'  a hostname the customer owns (DNS verified)
--   kind 'builtin' one per workspace; the funnel is served by this app at <APP_PUBLIC_URL>/s/<workspace slug>/<funnel slug>/<step path>
--   kind 'pages'   one per funnel published to Cloudflare Pages; its address is <project>.pages.dev (taken from funnel_publish.pages_host)
-- The hostname of a system domain is a synthetic ".invalid" name so it can never match a Host header.
ALTER TABLE workspaces ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug) WHERE slug IS NOT NULL;

ALTER TABLE funnels ADD COLUMN public_slug TEXT;
ALTER TABLE funnels ADD COLUMN allow_indexing INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnels_public_slug ON funnels(workspace_id, public_slug) WHERE public_slug IS NOT NULL;

ALTER TABLE domains ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('custom', 'builtin', 'pages'));
ALTER TABLE domains ADD COLUMN system_funnel_id TEXT;
CREATE INDEX IF NOT EXISTS idx_domains_system_funnel ON domains(system_funnel_id) WHERE system_funnel_id IS NOT NULL;
