# 0002. SQLite default, PostgreSQL for production, behind one async Db interface

Status: Accepted (supersedes the original "synchronous node:sqlite everywhere")

## Context

Every service called synchronous `node:sqlite`, which cannot be pointed at a server database, blocks the event loop on slow disks, and ruled out several replicas.

## Decision

One small async `Db` interface (`get/all/run/exec`, `transaction` with savepoints, `explain`) with `SqliteDb` (default, zero config), `PgDb` (`pg` pool, production) and `PgliteDb` (in-process PostgreSQL for tests). `DATABASE_URL=postgres://` selects PostgreSQL. SQL uses `?` placeholders and named dialect helpers; migrations live in per-dialect directories with shared numbering and an equivalence test. The whole test suite runs on every engine.

## Alternatives considered

Keep SQLite and add PostgreSQL beside it (two code paths in every service); an ORM or query builder; PostgreSQL only (kills the zero-config dev and single-container deployments); `citext`, `COLLATE NOCASE` and database-generated ids (not portable).

## Consequences

Ids are app-generated and time-sortable (ADR 0011), timestamps are ISO text, booleans integers, `rowid` is gone. Transactions must use the handle they are given (`inTx`). PGlite has one connection, so a real PostgreSQL CI job proves concurrency. SQLite remains single-writer: one replica.
