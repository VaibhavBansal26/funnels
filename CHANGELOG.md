# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic versioning](https://semver.org/). Update this file with every user-visible change, in the same commit.

## [Unreleased]

### Added
- PostgreSQL support: `DATABASE_URL=postgres://...` runs the same code on a `pg` pool; SQLite stays the zero-config default. Per-dialect migrations with a shared runner (advisory lock), schema equivalence test, whole test suite on SQLite, PGlite and real PostgreSQL.
- Layered distributed rate limiter (GCRA, sliding window, concurrency leases, penalty box, manual block/allow lists) on Redis Lua scripts or in memory, local lease tier, circuit breaker, fail-open/closed per policy, plan tiers, IETF `RateLimit` headers, `429`/`503` body contract, Prometheus metrics. See docs/RATE-LIMITING.md.
- `routes/spec.ts`: one declaration of every route (auth, roles, schemas, limiter policies); `docs/openapi.json` is generated from it.
- Edge rate limiting in the Cloudflare Worker (Workers Rate Limiting binding, Durable Object GCRA) and WAF rules.
- Platform admin endpoints `/api/admin/rate-limits*` and `/api/admin/workspaces/{id}/rate-tier`; `audit_log` table; `workspaces.plan`.
- Failed-login lockout per account and per IP; caps on concurrent CSV exports and open event streams.
- `docs:config`, `docs:api`, `docs:check`; docs index, ADRs, runbook, security, glossary, configuration reference.
- Benchmarks: `bench/ingest.mjs`, `ingest-db.mjs`, `ingest-engines.mjs`, `ratelimit.mjs`.

### Changed
- PostgreSQL: `events` is partitioned by month; opt-in/order idempotency keys moved to `event_dedupe` (30-day window) and first views to `visitor_steps`; a maintenance job creates partitions ahead and prunes keys (migration 006). First-view uniqueness is now exact across replicas.
- The data layer is asynchronous (`Db` interface, `inTx` transactions with post-commit side effects); ids are time-sortable; keyset cursors use `(created_at, id)` instead of `rowid`.
- Analytics rollups are written by the application, once per event batch, instead of by a SQLite trigger per row (3.3x cheaper writes). Funnel-level distinct visitors scan raw events again.
- `X-Forwarded-For` is read from the right (`TRUSTED_PROXY_HOPS`) instead of the left, which clients could forge.
- Rate limit errors are `{ error: { code, message, retry_after_s, policy } }` (previously `details.retryAfterSeconds`).
- Page saves, step changes and domain attachment take row locks in a fixed order, so concurrent writers on PostgreSQL produce exactly one winner and no duplicate paths.

### Removed
- `visitor_days` table and both SQLite maintenance triggers (migration 004).
- The per-process in-memory token bucket (`util/ratelimit.ts`).

### Security
- Unauthenticated `CF-Connecting-IP` and the leftmost `X-Forwarded-For` entry are no longer believed for rate limiting.

## [1.0.0]
Initial release: block-based page builder, templates, custom domains with DNS verification, public serving, analytics, leads and orders, signed webhooks, AI assistance, optional Cloudflare edge worker.
