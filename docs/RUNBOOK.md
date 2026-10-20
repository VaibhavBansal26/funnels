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
2. Required environment in production: `JWT_SECRET`, and `DATA_ENCRYPTION_KEY` once the analytics API is used; for PostgreSQL `DATABASE_URL`; with more than one replica `REDIS_URL`; behind a proxy `TRUST_PROXY=true` and `TRUSTED_PROXY_HOPS`. Full list: [CONFIGURATION.md](CONFIGURATION.md).
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

**Secret rotation.** `JWT_SECRET`: deploy the new value everywhere at once (all sessions end; it no longer affects the analytics identity pepper). `DATA_ENCRYPTION_KEY` (encrypts the pepper and TOTP seeds): to rotate, set the new value as `DATA_ENCRYPTION_KEY` and the old one as `DATA_ENCRYPTION_KEY_PREVIOUS`, deploy, and let each workspace's pepper be read once (any analytics export or `GET /api/v1/analytics/identity-pepper` does it; the value is re-encrypted under the new key without changing), then remove the previous key; TOTP seeds are not re-encrypted, so users with 2FA re-enrol. A lost key makes the pepper answer `409 PEPPER_UNREADABLE`: set a new pepper (`PUT /api/v1/analytics/identity-pepper`, ideally the one the other apps already use); exports change when the value changes. Upgrading from a version that stored the pepper in clear: set `DATA_ENCRYPTION_KEY` before deploying (production refuses the pepper without it), each pepper is encrypted on its first read. `EDGE_SHARED_SECRET` and `CF_ORIGIN_SECRET`: set on the Worker (`wrangler secret put`) and the origin together (a short window of 503/stale responses at the edge). Webhook secrets: `POST /api/webhooks/{id}/rotate-secret`. `DATABASE_URL`/`REDIS_URL` passwords: rotate in the provider, roll the deployment.

**Migration failed at boot.** The failing file's transaction rolled back; the process exits. Fix forward (new migration) or restore; other replicas keep running the old version. Never edit an applied migration.

## Page builder rollout (GrapesJS, ADR 0022)

* **First start after the upgrade** converts every stored page and template step from the old block document to a GrapesJS project (`migrateLegacyPages`, logged; it re-renders the affected funnels, so published pages change to the new base design) and applies migrations 016 (`legacy_doc_json`) and 018 (`assets`). It is idempotent, so a crash halfway is resumed by the next start. Take a database backup first: **an older image cannot read version-2 pages**, so the rollback of this release is a database restore (the originals are kept in `step_pages.legacy_doc_json`, which allows a manual conversion back only for pages not edited since).
* **A page that could not be converted** is replaced by an empty page and a `legacy page could not be converted` warning with the step id is logged. The log line is the reliable list; as a heuristic, converted pages that are now empty are short: `SELECT step_id FROM step_pages WHERE legacy_doc_json IS NOT NULL AND length(doc_json) < 300`. Rebuild them, or re-convert from `legacy_doc_json` after fixing the cause.
* **Images** are rows in `assets` (base64 text, 1.5 MB each, 200 per workspace): watch table size with the rest of the database; there is no garbage collection of images no page uses, deleting is manual (Images panel or `DELETE /api/assets/{id}`).
* **Customer domains and the Worker**: `/uploads/*` must pass through like `/beacon.js` (the bundled Worker and `hostRouting` do); a custom proxy needs the same rule or images break on customer domains.
* **Stuck editor for one user**: the builder is a lazy chunk; after a deploy a tab opened before it may fail to load the new chunk, a reload fixes it. Saves from a stale tab get `409 VERSION_CONFLICT`.

## Capacity

Numbers, formulas and sizing tables: [SCALING.md](SCALING.md) (each figure labelled measured or extrapolated). Per-node microbenchmarks: [PERFORMANCE.md](PERFORMANCE.md). Cloud validation procedure: [CLOUD-LOADTEST.md](CLOUD-LOADTEST.md).

Extra signals when the scale features are on: `funnels_ingest_queue_lag` (alert: above 100,000 for 5 min, or rising for 10), `funnels_ingest_shed_total` (any increase means users' beacons got 503), `funnels_outbox_unpublished` and `funnels_outbox_oldest_age_seconds` (alert: oldest above 60 s), Redis memory and `XLEN`/lag of `ingest.events`, PostgreSQL replication lag, partitions ahead (`SELECT max(relname) FROM pg_class WHERE relname LIKE 'events_2%'`, alert when fewer than 2 months ahead).

### Capacity incident playbooks

**Ingest backlog growing (`funnels_ingest_queue_lag`).** Consumers cannot keep up with arrivals. Check in order: (1) are consumers running (`ENABLE_WORKER=true` on enough pods; `kubectl top`); (2) PostgreSQL write latency and WAL (the consumer is one transaction per batch of up to 500 events per partition); (3) lock waits on `visitor_sketches` or `event_rollups` hot rows (`pg_stat_activity` waiting on `transactionid`): one very hot funnel-day serialises batches of that funnel by design (rows are locked in key order, no deadlock, but throughput for that funnel is bounded by one transaction at a time); (4) dead letters (`redis-cli XLEN funnels:bus:dlq:ingest.events:ingest`), a poison event is dead-lettered alone and the rest continue. Fix by scaling the app (more consumers split the 16 partitions; beyond 16 consumers raise `EVENT_BUS_PARTITIONS` after draining), then the database. The queue absorbs; nothing is lost while Redis has memory: watch `used_memory` against `maxmemory` (about 500 bytes per queued event), because the stream cap (`MAXLEN ~ 1,000,000` per partition) would drop the oldest entries.

**Beacons answered 503 `INGEST_BACKPRESSURE`.** Lag is above `INGEST_MAX_LAG`. This is the designed overload response (the Worker queue retries, browsers' beacons are best-effort); fix the backlog as above. Raising `INGEST_MAX_LAG` only moves the problem into Redis memory.

**Redis down or failing over while the ingest queue is on.** Event requests answer 5xx (publish fails) until Redis returns; the Worker queue (when enabled) retries those batches, so with the edge queue nothing is lost; without it, browsers lose the beacons sent in the gap. After a failover with asynchronous replication, up to about a second of acknowledged events can be missing: compare `rows_in_db` against the edge's accepted count if you need the number. Consumers resume by themselves; unacknowledged entries are redelivered and deduplicated by event id.

**Outbox not draining (`funnels_outbox_oldest_age_seconds` rising).** The relay cannot publish (Redis down) or no pod runs `ENABLE_WORKER`. Rows stay in `outbox_events` and are published in order when it recovers; nothing to repair. A very large backlog is drained 10,000 rows per relay pass (every `OUTBOX_POLL_MS`).

**Hot tenant / hot funnel.** One workspace at a very high rate maps to one ingest partition (ordering key = workspace id) and one funnel to one `visitor_sketches` row per day: its throughput is bounded by `ingest.workspace` (429 beyond it, other workspaces unaffected, see SCALING.md) and by one consumer and one serialised transaction. Find the tenant with `funnels_ratelimit_decisions_total{policy="ingest.workspace",outcome="limited"}` and the admin limited-keys view; raise or lower its tier with `PUT /api/admin/workspaces/{id}/rate-tier`. Webhook jobs and outbox rows are claimed round-robin per workspace, so a webhook storm of one tenant delays others by at most one claim. Symptoms: lag concentrated in one partition (`XINFO GROUPS` lag per `ingest.events:{p}` stream). Mitigation: set the workspace's plan tier lower (`PUT /api/admin/workspaces/{id}/rate-tier`), block abusive IPs (`/api/admin/rate-limits/blocks`); the per-IP and per-funnel limits shed at the edge before the queue.

**Replica lag.** Analytics and history reads fall back to the primary when a replica is more than `REPLICA_MAX_LAG_MS` behind (`db.read()`), so users see correct but slower data and the primary gets more reads. Fix the replica (IO, long queries, vacuum); a lagging replica is out of rotation automatically.

**Partition exhaustion.** Inserts into a month without a partition land in `events_default` and a later `CREATE` for that month fails. Check the maintenance job ran (`jobs` table, type `maintenance.run`); run `SELECT` from the list above; create the month by hand with `CREATE TABLE events_YYYY_MM PARTITION OF events FOR VALUES FROM ('YYYY-MM-01T00:00:00.000Z') TO ('YYYY-MM+1-01T00:00:00.000Z')`. If rows are already in `events_default` for that month, move them first (`WITH moved AS (DELETE FROM events_default WHERE created_at >= ... RETURNING *) INSERT INTO events SELECT * FROM moved` after creating the partition detached, then attach).

**Analytics from ClickHouse look stale or wrong (only with `ANALYTICS_READ_STORE=clickhouse`).** Set `ANALYTICS_READ_STORE=postgres` and restart: the primary is authoritative and always correct. `funnels_analytics_reads_total{source="stale"}` rising means the outbox is behind (see below); `source="fallback"` rising means ClickHouse is failing and the primary is answering (check ClickHouse logs, memory limits). Compare a funnel and range between the two before switching back.

**ClickHouse mirror behind.** The `clickhouse` consumer group retries with backoff and dead-letters after 8 attempts per batch; the primary is unaffected. Fix ClickHouse, then replay the dead letters or run `scripts/backfill-clickhouse.ts --from <day>` (idempotent).

**Reconnect storms.** Not applicable to Funnels (no long-lived connections other than the SSE stream, which clients retry with backoff).

## Admin area

* **An administrator lost their authenticator (production).** Admin routes need 2FA in production, so nobody can bypass it from the app. Another administrator cannot reset a colleague's 2FA. With database access: `DELETE FROM user_totp WHERE user_id = '<id>'; DELETE FROM recovery_codes WHERE user_id = '<id>';` (record why in your ticket), then the user enrols again at their next sign-in. Do this only after verifying their identity out of band.
* **No administrator can sign in.** Set `PLATFORM_ADMIN_EMAILS` to an existing user's email and restart: the row is created on their next admin request. Insert into `platform_admins (user_id, source, created_at)` with source `admin` if you cannot restart.
* **A suspension did not reach the edge.** Check the `edge.purge` job in the queue inspector (dead jobs) and Cloudflare credentials; retry the job. The origin already refuses the pages; only cached copies at the edge can linger until their TTL.
* **Impersonation is ending too soon or not at all.** It is a normal session row with `impersonator_id`; end it with `UPDATE sessions SET revoked_at = now WHERE impersonator_id IS NOT NULL`. Write-enabled sessions have `allow_writes = 1` and a `IMPERSONATION_WRITE_TTL_MINUTES` lifetime; to end only those add `AND allow_writes = 1`. A support session that gets `403 IMPERSONATION_READ_ONLY` is working as designed: a superadmin has to open a write-enabled one.
