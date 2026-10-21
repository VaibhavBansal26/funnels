-- Publish target 'cloudflare-workers-assets' (experimental): the CHECK constraint on funnel_publish.target gets the new value.
ALTER TABLE funnel_publish DROP CONSTRAINT IF EXISTS funnel_publish_target_check;
ALTER TABLE funnel_publish ADD CONSTRAINT funnel_publish_target_check CHECK (target IN ('origin', 'cloudflare-pages', 'cloudflare-workers-assets'));
