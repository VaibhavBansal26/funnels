# 0008. Application-maintained rollups; no visitor_days; no triggers

Status: Accepted (supersedes trigger-maintained rollups)

## Context

Analytics scanned millions of events. Triggers fixed reads but cost 3x on every write, and `visitor_days` added 58% more for a 30 ms gain (PERFORMANCE.md).

## Decision

`event_rollups` (15-minute UTC buckets) are written in the same transaction as the events, one upsert per bucket per batch, in a fixed key order. Reads sum buckets; funnel-level distinct visitors scan raw events.

## Alternatives considered

Triggers (per-row cost, SQLite-only); materialised views (refresh lag, PostgreSQL-only); a distinct-visitor sketch (HyperLogLog) when the exact scan becomes too slow.

## Consequences

Every event insert must go through `insertEvents`; a test pins rollups to a raw scan in four time zones.
