# 0013. Partitioned events with a dedupe table and visitor_steps

Status: Accepted

## Context

`events` is the table that reaches billions of rows. A unique index on `(funnel_id, type, external_id)` and a lookup index on `(funnel_id, step_id, visitor_id)` were needed for idempotency and "first view", but on a table partitioned by time a unique index must contain the partition key (so it stops deduplicating across months) and a lookup without a time bound probes every partition. The in-memory "seen" sets could not make first views exact across replicas.

## Decision

* On PostgreSQL `events` is partitioned by month on `created_at` (ISO text, `"C"` collation, full-instant bounds so a month range prunes to one partition). Local indexes per partition. A DEFAULT partition catches strays; a maintenance job (`maintenance.run`, every `MAINTENANCE_INTERVAL_HOURS`, also at boot) creates partitions `PARTITION_MONTHS_AHEAD` months ahead under an advisory lock. Retention is detaching a month (`ALTER TABLE events DETACH PARTITION`), not deleting rows.
* Idempotency keys (opt-in `externalId`, `order:<id>`) live in `event_dedupe(funnel_id, type, external_id)` (a small, unpartitioned table, pruned after `EVENT_DEDUPE_DAYS`). Claimed with `INSERT ... ON CONFLICT DO NOTHING RETURNING` in the same transaction as the events.
* "First view" is claimed in `visitor_steps(funnel_id, step_id, visitor_id)` the same way, at flush time. It replaces the lookup on `events`, removes the index `idx_events_visitor`, and makes the decision exact across replicas and independent of table size.
* SQLite keeps one unpartitioned `events` table with the same helper tables, so there is one code path (`insertEvents`).
* `leads` and `orders` are not partitioned: their uniqueness (lead per workspace and email, order idempotency per funnel) cannot include a time key. They are small compared with events (one row per person / purchase). If they ever need it, partition by hash of `workspace_id`, which keeps those unique constraints valid.

## Alternatives considered

Keeping the unique indexes and partitioning by hash of `funnel_id` (a viral funnel becomes one hot partition and time-based retention is lost); `pg_partman` (an extension not available on every managed service; the job is ten lines); deciding first views from raw events with a time bound (changes semantics); a probabilistic filter.

## Consequences

`visitor_steps` grows by one row per (funnel, step, visitor) forever; it is a candidate for hash partitioning by `funnel_id` and for expiry of cold funnels. Idempotency keys older than the window are forgotten by design. Queries on `events` must bound `created_at` to benefit from pruning (analytics ranges do). The migration rewrites `events` once (copy into the partitioned table), which locks writes: run it in a maintenance window on a large existing database.
