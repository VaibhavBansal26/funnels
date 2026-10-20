# Runbook

Operating Funnels. Numbers marked *target* are proposals to adopt or change, not measured service levels.

## Dashboards and alerts

Scrape `/metrics` (Prometheus; protect with `METRICS_TOKEN`). Build panels and alerts on:

| Signal | Metric | Alert |
|---|---|---|
| Errors | `funnels_http_requests_total{status="5xx"}` | 5xx ratio > 1% for 5 min |
| Latency | `funnels_http_request_duration_seconds` by route | p99 of page and event routes above target for 10 min |
| Event buffer | `funnels_event_buffer_depth`, `funnels_events_dropped_total` | depth near `EVENT_BUFFER_MAX` for 2 min; any increase of dropped |
| Job queue | `funnels_jobs{status}` | `queued` growing for 10 min, any `dead` increase |
| Limiter | `funnels_ratelimit_breaker_state`, `funnels_ratelimit_decisions_total{outcome="fail_open"\|"error"}`, `funnels_ratelimit_store_seconds` | breaker > 0, any fail_open/error, Redis p99 above `REDIS_TIMEOUT_MS` |
| Readiness | `GET /readyz` (database reachable, migrations applied, buffer depth) | failing for 1 min |
| Process | default Node metrics (`nodejs_eventloop_lag_seconds`, memory) | loop lag p99 > 200 ms |

SLO *targets*: public page and event endpoints 99.9% available monthly with p99 < 300 ms at the origin (edge cache hits are not counted); admin API 99.5%; webhook delivery within 5 minutes for 99% of events; no accepted event lost except on a hard kill within the buffer window.

## Deploy

1. `npm run build`; image from the `Dockerfile` (or `docker compose up --build`).
2. Required environment in production: `JWT_SECRET`; for PostgreSQL `DATABASE_URL`; with more than one replica `REDIS_URL`; behind a proxy `TRUST_PROXY=true` and `TRUSTED_PROXY_HOPS`. Full list: [CONFIGURATION.md](CONFIGURATION.md).
3. Migrations run at boot, each in its own transaction, under an advisory lock on PostgreSQL, so replicas can start together. The first replica applies them; the others wait and skip.
4. Roll out one replica, watch `/readyz` and 5xx, then the rest. `SIGTERM` stops the worker, finishes in-flight requests, flushes the event buffer, closes the pool (10 s hard stop). Set the orchestrator grace period above 10 s.

Kubernetes manifests are in `deploy/k8s` (single replica by default with SQLite; with PostgreSQL and Redis scale `replicas` and enable `optional/hpa.yaml`).

## Rollback

Migrations are forward-only. To roll back the application, deploy the previous image: schema additions are backward compatible by convention (new columns have defaults; a column or table is dropped only in a later release than the code stops using it). Migration 004 (drops `visitor_days` and the SQLite triggers) is not reversible; roll back past it only from a backup. If a release must be undone after a destructive migration: restore the backup taken before the deploy.

## Backups and restore

* **PostgreSQL**: continuous archiving / point-in-time recovery from your provider, plus a daily logical dump (`pg_dump -Fc`). Restore into a new database, point `DATABASE_URL` at it, start one replica and check `/readyz`. Rehearse quarterly.
* **SQLite**: `sqlite3 funnels.db ".backup /backups/funnels-$(date +%F).db"` (safe while running, WAL mode) or a volume snapshot; copy off the host. Restore by stopping the app and replacing the file (delete stale `-wal`/`-shm`).
* Redis holds no durable data (limiter state, expires by itself); do not back it up.
* Secrets (`JWT_SECRET`, `EDGE_SHARED_SECRET`, webhook secrets in the database) must be recoverable separately; losing `JWT_SECRET` only logs users out.

## Incident playbooks

**Database down.** Symptoms: `/readyz` fails, 5xx everywhere, `event flush failed` logs. Action: check the database and (PostgreSQL) connection exhaustion (`replicas x DATABASE_POOL_MAX` against `max_connections`; use PgBouncer in session or transaction mode, named statements need session mode or `DISCARD`-safe settings). Events queued in memory are written when it returns; a restart during the outage loses up to `EVENT_BUFFER_MAX` rows. Edge-cached pages keep being served (stale-if-error up to 24 h by default).

**Redis down.** Symptoms: `funnels_ratelimit_breaker_state` 2, `fail_open`/`error` outcomes. Fail-open routes keep working unprotected; sign-up, login and form/checkout posts return `503 RATE_LIMITER_UNAVAILABLE` (by design). Action: restore Redis; the breaker probes every 2 s and closes by itself. If Redis will be down long, either accept the 503s on those four endpoints or temporarily unset `REDIS_URL` (per-process limiter, restart needed) or set `RATELIMIT_ENABLED=false` for a short, watched window and rely on Cloudflare WAF rules.

**Event buffer growing / events dropping.** The database is slow or down (see above). `EVENT_BUFFER_MAX` forces synchronous flushes, which slows ingestion requests: that is the backpressure. Scale the database, not the buffer.

**Job queue backlog.** `funnels_jobs{status="queued"}` rising: workers are down (`ENABLE_WORKER`), the database is slow, or a provider is failing. `dead` jobs are visible in `webhook_deliveries` (status `dead`) and `jobs`. Retries back off 30 s x 2^n. Restart workers; re-queue a delivery with `POST /api/webhooks/deliveries/{id}/retry`.

**Webhook failures.** A customer endpoint failing returns `failed` then `dead` after `WEBHOOK_MAX_ATTEMPTS`; the customer can retry from the delivery log. Blocked targets (private IPs) die immediately with the reason in `error`.

**Provider outage (Cloudflare, Anthropic, DNS).** Cloudflare: the origin serves pages itself (host routing); purges retry for 5 attempts then dead-letter, TTL (60 s) converges anyway. Anthropic: AI features fall back to the heuristic provider per call. DNS resolver errors: domains stay `pending` and are re-checked with backoff; an `active` domain is only demoted by a definitive failed check.

**Cache poisoning / wrong page served at the edge.** Purge the URLs (`POST` a purge from the Cloudflare dashboard or save the page again, which queues `edge.purge`), then check the stored page (`GET .../page`). The cache key is host + path only; the origin never caches personalised content. Rotate `EDGE_SHARED_SECRET` if the signing key may be exposed.

**Hot funnel / traffic spike.** Pages: ensure the Worker is in front (cache hit ratio), raise `CACHE_TTL_SECONDS`. Events: the buffer absorbs bursts; per-IP and per-funnel limits protect the database. If one tenant dominates, block or lower its quota with `PUT /api/admin/workspaces/{id}/rate-tier`.

**Account lockout / abuse.** `POST /api/admin/rate-limits/blocks` (ip, workspace or user, with TTL) and `DELETE` to lift; every action is in `audit_log`.

**Deadlock or lock wait on PostgreSQL.** Deadlocks (`40P01`) are retried three times transparently; a steady stream means a code path takes locks out of order (see ARCHITECTURE.md, lock order). Find it with `pg_stat_activity` and `log_lock_waits`.

**Secret rotation.** `JWT_SECRET`: deploy the new value everywhere at once (all sessions end). `EDGE_SHARED_SECRET` and `CF_ORIGIN_SECRET`: set on the Worker (`wrangler secret put`) and the origin together (a short window of 503/stale responses at the edge). Webhook secrets: `POST /api/webhooks/{id}/rotate-secret`. `DATABASE_URL`/`REDIS_URL` passwords: rotate in the provider, roll the deployment.

**Migration failed at boot.** The failing file's transaction rolled back; the process exits. Fix forward (new migration) or restore; other replicas keep running the old version. Never edit an applied migration.

## Capacity

The measured per-node numbers and their limits are in [PERFORMANCE.md](PERFORMANCE.md); there is no multi-node or cloud measurement yet.
