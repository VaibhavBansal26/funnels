# 0016. ClickHouse as a secondary analytics store behind the EventStore interface

Status: Accepted (implementation not yet validated against a live ClickHouse server, see docs/CLOUD-LOADTEST.md)

## Context

PostgreSQL rollups answer funnel dashboards, but ad-hoc analysis over billions of raw events (new breakdowns, cohorts, exact distincts over long ranges) wants a columnar store.

## Decision

`EventStore` interface with `PostgresEventStore` (primary, authoritative: dedupe, first-view decision, rollups) and `ClickHouseEventStore` (secondary). With `EVENTSTORE_MIRROR=clickhouse` every batch the primary stores also writes outbox rows, a consumer group inserts them over ClickHouse's HTTP interface (`JSONEachRow`), and `deploy/clickhouse/schema.sql` defines `events` (ReplacingMergeTree, monthly partitions), a 15-minute rollup (SummingMergeTree + materialised view) and per-day `uniq` states (AggregatingMergeTree). Replays are neutralised by ClickHouse block deduplication (`insert_deduplication_token` = outbox id) and by ReplacingMergeTree on the event id. `server/scripts/backfill-clickhouse.ts` copies history from PostgreSQL in keyset batches; it is idempotent.

## Alternatives considered

ClickHouse as the only store (loses the transactional idempotency decisions and first-view semantics PostgreSQL gives for free); dual write from the request (can diverge); Kafka plus ClickHouse Kafka engine (adds a broker; fits behind the same interface later).

## Consequences

The analytics API still reads PostgreSQL rollups; a ClickHouse read path is future work. ClickHouse is eventually consistent with the primary by the outbox and consumer lag. Rollup materialised views see every insert block, so correctness under replay depends on block deduplication being enabled (documented in the schema); verify it on the real cluster before relying on the ClickHouse rollups.
