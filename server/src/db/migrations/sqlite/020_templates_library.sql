-- Template library served from the backend (docs/TEMPLATES.md, ADR 0023): versioned built-in templates, imported templates, metadata for filtering.
ALTER TABLE templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
-- builtin: shipped with the app (upgraded when the built-in version is newer); imported: added through the admin import; user: published from a funnel.
ALTER TABLE templates ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE templates ADD COLUMN industry TEXT NOT NULL DEFAULT 'general';
ALTER TABLE templates ADD COLUMN goal TEXT NOT NULL DEFAULT 'leads';
ALTER TABLE templates ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
-- Product placeholders ("slots") that checkout blocks refer to; bound to the workspace catalog when the template is used.
ALTER TABLE templates ADD COLUMN products_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE templates ADD COLUMN accent TEXT NOT NULL DEFAULT '#2563eb';
ALTER TABLE templates ADD COLUMN heading TEXT;
-- An administrator edited a built-in template: the seed no longer replaces it.
ALTER TABLE templates ADD COLUMN customized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE template_steps ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';
UPDATE templates SET source = 'user' WHERE id <> 'tpl_' || slug;
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category_id);
