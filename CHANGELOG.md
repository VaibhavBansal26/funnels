# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic versioning](https://semver.org/). Update this file with every user-visible change, in the same commit.

## [Unreleased]

### Added
- Analytics API v1 (docs/ANALYTICS-API.md, ADR 0019): workspace API keys (`fa_live_` / `fa_test_`, scopes, expiry, IP allow-list, revocation), funnel, step and time-series endpoints, NDJSON exports of events and leads with HMAC identity keys (`contact_key`, `visitor_key`) and a per-workspace pepper, funnel structure, `GET /schema`, JSON Schema files in `docs/analytics-api/` validated against live responses, per-key and per-workspace rate limits, and the `analytics.daily_rollup_ready` webhook. Events now record `device`, `referrer_host` and (verified Cloudflare only) `country`.
- Access control (docs/RBAC.md, ADR 0018): permission-based roles (built-in owner, admin, member, viewer; custom roles per workspace) enforced centrally from the route declaration with a generated policy-matrix test; no privilege escalation (grant only what you hold; last owner protected); sessions with 15-minute access tokens and rotating refresh tokens with reuse detection; invitations by one-time link; password reset; TOTP two-factor authentication with recovery codes (RFC 6238 vectors tested, secrets encrypted at rest); failed-login lockout covering passwords and second factors; audit log API (`GET /api/audit`); mail transport abstraction (`MAIL_TRANSPORT`).
- Optional ClickHouse analytics read path behind the `AnalyticsReader` interface (`ANALYTICS_READ_STORE`, off by default; falls back to the primary on error or when the mirror is stale; metric `funnels_analytics_reads_total`). Tested against a fake HTTP server only: unverified against a real ClickHouse.
- `e2e/`: Playwright browser smoke suite (14 tests) against the built server and web app, `npm run e2e`, CI job `e2e`.
- Per-workspace fairness: `ingest.workspace` admission policy (`INGEST_WORKSPACE_PER_MINUTE`, plan tiers, `onFail: local`), ingest partitions keyed by workspace, round-robin per-workspace claims for the outbox relay and the job queue (`jobs.group_key`, migration 009), `loadtest/noisy.mjs` and `test/fairness.test.ts`. Rate-limit policies gain `onFail: local` and the `fallback` outcome.
- `docs/SCALING.md`, `docs/CLOUD-LOADTEST.md`, capacity playbooks in the runbook; `loadtest/scale.mjs` (N nodes + Redis + PostgreSQL with loss/duplicate verification and node kill), `loadtest/k6/*` and `deploy/k6/testrun.yaml`, `deploy/k8s-scale/` overlay, `bench/volume.mjs`.
- Durable `EventBus` (Redis Streams with partition leases, consumer groups, retry with jitter, dead letters, batch handlers, lag; in-memory implementation; Kafka and NATS stubs) with one contract suite, including a SIGKILL test.
- Ingest queue (`INGEST_QUEUE=true`): the events endpoint publishes and a consumer group writes batches idempotently; `503 INGEST_BACKPRESSURE` above `INGEST_MAX_LAG`.
- Transactional outbox (`outbox_events`, migration 008) with a relay that is safe on every replica, `once()` consumer markers, optional `lead.created`/`order.created` domain events (`OUTBOX_DOMAIN_EVENTS`).
- `EventStore` interface and a ClickHouse secondary store (`EVENTSTORE_MIRROR=clickhouse`, `deploy/clickhouse/schema.sql`, `scripts/backfill-clickhouse.ts`). Not yet validated against a live ClickHouse.
- Edge event queue: the Worker can answer beacons with 202 and queue them (Cloudflare Queues); `POST /internal/edge/events` accepts the signed batches and dedupes redeliveries.
- Metrics `funnels_ingest_queue_lag`, `funnels_ingest_published_total`, `funnels_ingest_shed_total`, `funnels_outbox_unpublished`, `funnels_outbox_oldest_age_seconds`.
- Distinct visitors by HyperLogLog: per funnel-day sketches (`visitor_sketches`, migration 007, 1.6% standard error) maintained in the event-batch transaction; ranges above `ANALYTICS_EXACT_DISTINCT_MAX` page views use them (`ANALYTICS_DISTINCT_MODE=auto|exact|sketch`), smaller ranges stay exact. The analytics response reports `distinct.method` and `distinct.standardErrorPct`.
- PostgreSQL support: `DATABASE_URL=postgres://...` runs the same code on a `pg` pool; SQLite stays the zero-config default. Per-dialect migrations with a shared runner (advisory lock), schema equivalence test, whole test suite on SQLite, PGlite and real PostgreSQL.
- Layered distributed rate limiter (GCRA, sliding window, concurrency leases, penalty box, manual block/allow lists) on Redis Lua scripts or in memory, local lease tier, circuit breaker, fail-open/closed per policy, plan tiers, IETF `RateLimit` headers, `429`/`503` body contract, Prometheus metrics. See docs/RATE-LIMITING.md.
- `routes/spec.ts`: one declaration of every route (auth, roles, schemas, limiter policies); `docs/openapi.json` is generated from it.
- Edge rate limiting in the Cloudflare Worker (Workers Rate Limiting binding, Durable Object GCRA) and WAF rules.
- Platform admin endpoints `/api/admin/rate-limits*` and `/api/admin/workspaces/{id}/rate-tier`; `audit_log` table; `workspaces.plan`.
- Failed-login lockout per account and per IP; caps on concurrent CSV exports and open event streams.
- `docs:config`, `docs:api`, `docs:check`; docs index, ADRs, runbook, security, glossary, configuration reference.
- Benchmarks: `bench/ingest.mjs`, `ingest-db.mjs`, `ingest-engines.mjs`, `ratelimit.mjs`.

### Changed
- **Breaking:** `POST /api/members` (temporary password) removed in favour of invitations; `PATCH /api/members/{id}` takes `{ roleId }`; access tokens are 15 minutes by default and carry a session id (everyone signs in once after the upgrade); a workspace may have several owners. See MIGRATION-NOTES.md.
- Fixed: clicking a block in the builder canvas did nothing when the app was served with its own Content-Security-Policy (`script-src 'self'` blocked the canvas's inline editor script). The script is now the static file `/editor-bridge.js`. Found by the new browser suite; jsdom tests cannot see CSP.
- The AI daily cap is now the registry policy `ai.daily` (sliding window, plan-tier scaled, shared across replicas through the limiter store) instead of a database counter; `ai_usage` only meters. Calendar-day reset became a sliding 24 h window.
- Fixed: two replicas booting together on an empty PostgreSQL database could crash with a duplicate key on `schema_migrations` (the table was created before the migration lock was taken).
- The public events endpoint caches "this funnel and step exist" for `EVENT_REF_CACHE_SECONDS` (default 5) instead of two database reads per beacon.
- Fixed: the same event id twice in one batch was counted twice in the rollups (the row was inserted once); it is now counted once.
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
