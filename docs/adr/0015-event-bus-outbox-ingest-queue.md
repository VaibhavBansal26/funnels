# 0015. Durable event bus, transactional outbox and the ingest queue

Status: Accepted

## Context

Ingestion must absorb bursts (100,000 events/s peak against a 20,000/s sustained target) without the request path waiting on PostgreSQL, and must not lose or double count an event through process crashes, Redis restarts or database failover. Secondary consumers (ClickHouse, a warehouse) need every stored event without a second write path that can drift from the primary.

## Decision

* `EventBus` interface (`server/src/queue/eventbus.ts`): `publish(topic, key, payload, id)`, `subscribe({group, handler | batchHandler})`, `lag`, `deadLetters`. At-least-once delivery, per-key order within a consumer group, retry with jittered backoff, dead letters. Implementations: `RedisStreamsBus` (default when `REDIS_URL` is set: P partition streams per topic, a short Redis lease so one consumer of a group reads a partition at a time, XACK only after the handler succeeds, a new owner drains the pending entries before reading new ones), `MemoryBus` (one process, tests, not durable), and `KafkaBus`/`NatsBus` stubs that fail loudly. One contract test suite runs against every real implementation.
* Ingest queue (`INGEST_QUEUE=true`): the public events endpoint publishes the validated event to `ingest.events` keyed by funnel id and answers 202. A consumer group writes batches with `EventBuffer.persist`, which is idempotent by event id (primary key plus `ON CONFLICT DO NOTHING`, rollups counted from the rows actually inserted), so at-least-once delivery has an exactly-once effect. When the group's backlog exceeds `INGEST_MAX_LAG` the endpoint answers 503 `INGEST_BACKPRESSURE`. A poison event is dead-lettered alone (a failed batch is retried one event at a time).
* Transactional outbox (`outbox_events`, migration 008): a row is written in the same transaction as the change; a relay (every replica, one at a time via a PostgreSQL advisory lock) publishes it after commit and marks it. Used for the ClickHouse mirror (one row per up to 500 stored events, written inside the batch transaction) and for optional domain events (`lead.created`, `order.created`).
* The Cloudflare Worker can sit in front of this with a Cloudflare Queue (docs/CLOUDFLARE.md): it answers 202, the queue consumer forwards signed batches to `/internal/edge/events`, and ids and times assigned at the edge make a redelivery the same row.

## Alternatives considered

Kafka as the default (operationally heavy for the first 20,000 events/s; the interface keeps it open); BullMQ for ingestion (a job per event is too expensive, and no partition-ordered consumption); publishing to the bus directly from the request after the database write (can lose events between commit and publish, which is exactly what the outbox prevents); a database table as the ingest queue (puts the load we are trying to avoid back on PostgreSQL).

## Consequences

Redis becomes a durability dependency of ingestion when `INGEST_QUEUE` is on: run it with AOF (`appendfsync everysec` loses at most one second on a Redis crash) or accept that window, and size `maxmemory` for the backlog (about 500 bytes per queued event). Events are visible in analytics only after the consumer writes them (seconds). `MAXLEN ~` on the streams bounds memory but would discard the oldest unconsumed entries, so alert on `funnels_ingest_queue_lag` long before the cap. Changing `EVENT_BUS_PARTITIONS` reshuffles keys and needs the topics drained first.
