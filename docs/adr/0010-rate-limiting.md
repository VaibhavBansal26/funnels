# 0010. Rate limiting: GCRA and sliding windows in Redis Lua, one declaration of routes and policies

Status: Accepted (supersedes the per-process token bucket)

## Context

The in-memory limiter cannot be shared by replicas, had no tiers, headers, lockout, observability or edge story.

## Decision

Atomic Lua scripts (one call per decision, Redis `TIME`, hash-tagged keys), an in-memory twin proven equivalent by a randomised test, a local lease tier for hot keys, a timeout budget with a circuit breaker, fail-open or fail-closed per policy, and `routes/spec.ts` as the single table binding routes to policies (tests fail for uncovered routes). Details: RATE-LIMITING.md.

## Alternatives considered

A Redis rate-limit library (not Cluster-safe or not combinable with penalty and lists); token bucket (two numbers per key, no exact Retry-After); limiting in the load balancer only (no tenant tiers).

## Consequences

Redis becomes an optional dependency with a defined failure mode. Fail-closed policies make Redis an availability dependency for sign-up, login and form posts.
