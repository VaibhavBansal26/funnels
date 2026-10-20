-- Transactional outbox (docs/SCALING.md, ADR 0015): a domain event is written in the same transaction as the change it describes and published to the
-- event bus by a relay after COMMIT. `consumed_events` lets a consumer apply an event exactly once (marker and effect commit together).
CREATE TABLE outbox_events (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX idx_outbox_unpublished ON outbox_events(ord) WHERE published_at IS NULL;
CREATE INDEX idx_outbox_published ON outbox_events(published_at) WHERE published_at IS NOT NULL;

CREATE TABLE consumed_events (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);
