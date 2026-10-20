# 0016. ClickHouse as a secondary analytics store behind the EventStore interface

Status: Accepted (implementation not yet validated against a live ClickHouse server, see docs/CLOUD-LOADTEST.md)

## Context

PostgreSQL rollups answer funnel dashboards, but ad-hoc analysis over billions of raw events (new breakdowns, cohorts, exact distincts over long ranges) wants a columnar store.

## Decision

`EventStore` interface with `PostgresEventStore` (primary, authoritative: dedupe, first-view decision, rollups) and `ClickHouseEventStore` (secondary). With `EVENTSTORE_MIRROR=clickhouse` every batch the primary stores also writes outbox rows, a consumer group inserts them over ClickHouse's HTTP interface (`JSONEachRow`), and `deploy/clickhouse/schema.sql` defines `events` (ReplacingMergeTree, monthly partitions), a 15-minute rollup (SummingMergeTree + materialised view) and per-day `uniq` states (AggregatingMergeTree). Replays are neutralised by ClickHouse block deduplication (`insert_deduplication_token` = outbox id) and by ReplacingMergeTree on the event id. `server/scripts/backfill-clickhouse.ts` copies history from PostgreSQL in keyset batches; it is idempotent.

## Read path (added later, same status)

Analytics reads go through an `AnalyticsReader` interface: `SqlReader` (the primary, default) and `ClickHouseReader` (`ANALYTICS_READ_STORE=clickhouse`, feature-flagged, off by default). The reader answers four questions (per-step totals, funnel totals, 15-minute buckets, distinct visitors) from `event_rollups_15m` and `events`. Safeguards: every query is parameterised (ClickHouse `{name:Type}` parameters), read-only and filtered by workspace and funnel; ClickHouse is bypassed while the mirror is stale (oldest unpublished outbox row older than `ANALYTICS_CLICKHOUSE_MAX_LAG_S`) and on any error the primary answers (`ANALYTICS_CLICKHOUSE_FALLBACK`). Distinct visitors are `uniqExact` up to the same threshold as the primary and `uniqHLL12` (1.6% by HyperLogLog theory, not measured) above it; the response says which (`distinct.method` is `clickhouse_exact` or `clickhouse_hll`).

**Unverified:** the queries were tested against a fake HTTP server that answers from the primary database, which proves request construction, parameter handling, response parsing, fallback and the staleness guard. The ClickHouse SQL itself (function names, `parseDateTimeBestEffort`/`parseDateTime64BestEffort`, `formatDateTime`, type coercions, SummingMergeTree summation) has never been executed.

## Alternatives considered

ClickHouse as the only store (loses the transactional idempotency decisions and first-view semantics PostgreSQL gives for free); dual write from the request (can diverge); Kafka plus ClickHouse Kafka engine (adds a broker; fits behind the same interface later).

## Consequences

By default the analytics API reads PostgreSQL rollups; the ClickHouse read path above is optional. ClickHouse is eventually consistent with the primary by the outbox and consumer lag. Rollup materialised views see every insert block, so correctness under replay depends on block deduplication being enabled (documented in the schema); verify it on the real cluster before relying on the ClickHouse rollups.
