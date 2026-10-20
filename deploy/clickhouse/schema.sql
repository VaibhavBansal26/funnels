-- ClickHouse schema for the Funnels analytics EventStore (docs/SCALING.md, docs/CLOUD-LOADTEST.md).
-- Apply with:  clickhouse-client --multiquery < deploy/clickhouse/schema.sql
-- NOT VERIFIED against a live ClickHouse in this repository's test environment; run it first in staging (docs/CLOUD-LOADTEST.md step 5).
CREATE DATABASE IF NOT EXISTS funnels;

-- Raw events. ReplacingMergeTree collapses replays of the same event at merge time; query with FINAL (or argMax) when exact row counts matter.
-- The ordering key leads with funnel_id so "one funnel, a date range" reads a contiguous range; the hour bucket keeps replays of one event adjacent.
CREATE TABLE IF NOT EXISTS funnels.events
(
  id            String,
  workspace_id  String,
  funnel_id     String,
  step_id       String,
  type          LowCardinality(String),
  visitor_id    String,
  unique_visit  UInt8,
  lead_id       String,
  order_id      String,
  external_id   String,
  amount_cents  Int64,
  currency      LowCardinality(String),
  utm_json      String,
  url           String,
  device        LowCardinality(String),
  country       LowCardinality(String),
  referrer_host String,
  created_at    DateTime64(3, 'UTC'),
  ingested_at   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (funnel_id, type, toStartOfHour(created_at), id)
SETTINGS non_replicated_deduplication_window = 1000;
-- On a replicated cluster use ReplicatedReplacingMergeTree; block-level deduplication (insert_deduplication_token) is then on by default.

-- 15-minute rollups, the same shape as event_rollups in PostgreSQL. SummingMergeTree adds rows with the same key at merge time.
CREATE TABLE IF NOT EXISTS funnels.event_rollups_15m
(
  workspace_id String,
  funnel_id    String,
  step_id      String,
  bucket       DateTime('UTC'),
  page_views   UInt64,
  unique_views UInt64,
  optins       UInt64,
  orders       UInt64,
  cents        Int64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (funnel_id, step_id, bucket)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS funnels.event_rollups_15m_mv TO funnels.event_rollups_15m AS
SELECT
  workspace_id, funnel_id, step_id,
  toStartOfFifteenMinutes(created_at) AS bucket,
  countIf(type = 'page_view')           AS page_views,
  countIf(type = 'page_view' AND unique_visit = 1) AS unique_views,
  countIf(type = 'optin')               AS optins,
  countIf(type = 'order')               AS orders,
  sumIf(amount_cents, type = 'order')   AS cents
FROM funnels.events
GROUP BY workspace_id, funnel_id, step_id, bucket;

-- Distinct visitors per funnel and day as a mergeable uniq state: sum over any range with uniqMerge (about 1% error by default, exact via uniqExact on events).
CREATE TABLE IF NOT EXISTS funnels.visitors_daily
(
  funnel_id String,
  day       Date,
  visitors  AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (funnel_id, day)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS funnels.visitors_daily_mv TO funnels.visitors_daily AS
SELECT funnel_id, toDate(created_at) AS day, uniqState(visitor_id) AS visitors
FROM funnels.events
WHERE type = 'page_view' AND visitor_id != ''
GROUP BY funnel_id, day;

-- Example reads
-- SELECT sum(page_views), sum(unique_views) FROM funnels.event_rollups_15m WHERE funnel_id = {f:String} AND bucket >= {from:DateTime} AND bucket < {to:DateTime};
-- SELECT uniqMerge(visitors) FROM funnels.visitors_daily WHERE funnel_id = {f:String} AND day BETWEEN {a:Date} AND {b:Date};
