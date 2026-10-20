-- Per-workspace fair queueing (docs/SCALING.md, ADR 0017): jobs carry the group (workspace) they belong to so the claim can round-robin across groups.
ALTER TABLE jobs ADD COLUMN group_key TEXT;
