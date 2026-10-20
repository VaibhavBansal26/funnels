# 0007. Write-behind buffer for analytics events

Status: Accepted

## Context

Per-request inserts made ingestion commit-bound, and bursts must not become database load one-for-one.

## Decision

Events are queued in memory and written in one transaction every `EVENT_BUFFER_MS` or `EVENT_BUFFER_MAX` rows (backpressure: the caller awaits that flush). Readers flush first; shutdown flushes; the first-view decision consults stored and queued rows.

## Alternatives considered

Write-through; a durable queue (Redis Streams, BullMQ) which is the next step for crash safety.

## Consequences

A hard kill loses up to one window. Two replicas can both count a visitor's first view. Documented in PERFORMANCE.md.
