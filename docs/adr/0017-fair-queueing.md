# 0017. Per-workspace fairness: admission quota, partition by workspace, round-robin claims

Status: Accepted

## Context

Ingest queue, outbox relay and job queue were FIFO. One workspace sending a million events or webhooks delays everybody queued behind it, and the shared limiter only keyed public events by IP and funnel (a distributed flood from many IPs at one funnel passed).

## Decision

* Admission: policy `ingest.workspace` (GCRA per workspace, one-second burst, plan tiers, per-workspace override) checked in `recordPublicEvent` before an event is queued. Refusal is 429 for that workspace only. `onFail: local` (new fail mode): when the store is slow or down the same arithmetic runs on the process's own memory store, so the guard survives exactly the moment (an overloaded Redis) when it matters.
* Ingest partition key = workspace id (was funnel id). A funnel belongs to one workspace, so per-funnel order is preserved.
* Outbox relay and job claim rank candidates per key/group (`ROW_NUMBER() OVER (PARTITION BY ...)` over the oldest 20,000 / 2,000 rows) and take rank 1 of every group, then rank 2, and so on. A lone group still fills the whole claim. Jobs gain `group_key` (migration 009); ungrouped jobs are their own group. Candidates are locked in a second statement because `SKIP LOCKED` cannot be combined with a window function. On PostgreSQL the claim transaction takes a transaction-scoped advisory lock first: without it concurrent workers rank the same oldest candidates and all but one lose them to `SKIP LOCKED` (a real-PostgreSQL test, `pg-real.test.ts`, caught this: 10 of 40 jobs claimed by 6 workers).

## Alternatives considered

Weighted fair queueing with per-tenant sub-queues in the bus (more moving parts, and admission already bounds each tenant's backlog); a per-workspace concurrency cap on jobs (does not help the claim order); making every Redis-backed policy local-on-failure (auth and forms must stay fail-closed, general API fail-open is acceptable).

## Consequences

Tenants sharing an ingest partition still share its consumer: a workspace inside its quota can add latency for a partition neighbour (bounded by the quota, not measured). The fairness window is bounded (a tenant with more than 20,000 / 2,000 older rows ahead of everyone is served within the window, not globally). With `local` fallback the effective quota across N processes during a Redis outage is N times the limit.
