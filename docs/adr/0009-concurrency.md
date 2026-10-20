# 0009. Optimistic page versions plus ordered row locks

Status: Accepted

## Context

With a real multi-connection database, JavaScript no longer serialises "check then write".

## Decision

Saves carry the loaded `version`; `savePage` locks the funnel, then the step row, compares with the committed version and updates `WHERE version = old`. Lock order is workspace, domain, funnel, steps by id, others; deadlocks are retried. Names derived from existing names (copies) take a workspace-level `FOR NO KEY UPDATE`.

## Alternatives considered

Serializable isolation everywhere (retries on hot rows); advisory locks (invisible to the schema, session-scoped hazards with PgBouncer).

## Consequences

Every structural write path must go through `lockFunnel`; the real-PostgreSQL suite exercises it.
