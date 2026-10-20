# Cloud load test: validating the Funnels scale targets

Nothing in this file has been run in a cloud environment. It is the procedure and the result tables to fill in. The figures in [SCALING.md](SCALING.md) that come from a laptop are labelled *measured here*; the cloud run is what turns *extrapolated* into *measured* (or disproves it).

Targets under test (SCALE-TARGETS.md, Funnels): 50,000 page req/s at the edge with >= 99% cache hits; origin >= 2,000 req/s on misses with single-flight; 20,000 events/s sustained and 100,000/s absorbed by queues with exactly-once effect; analytics over any range < 300 ms p95; 1B+ events retained; one tenant at 100x must not move other tenants' p99.

## 1. Infrastructure sketch

| Component | Sizing for the full run | Notes |
|---|---|---|
| App (Kubernetes, this repo's image) | 8 x 2 vCPU / 2 GiB pods to start, HPA up to 24 | `kubectl kustomize deploy/k8s-scale`, 4 replicas to start, spread over 3 zones |
| PostgreSQL primary | 16 vCPU / 64 GiB, NVMe or provisioned IOPS >= 20k, `shared_buffers` 16 GiB, `max_wal_size` 16 GiB, `synchronous_commit` on | RDS / Aurora / Cloud SQL. Start with one primary; the sizing table in SCALING.md says when to add shards |
| PostgreSQL replicas | 2 x 8 vCPU, same storage class | `DATABASE_REPLICA_URLS`; analytics and history reads |
| PgBouncer | 2 pods, transaction pooling, `default_pool_size` 40, `max_client_conn` 2000 | `DATABASE_PREPARED_STATEMENTS=false` |
| Redis | 1 primary + 1 replica, 4 vCPU / 16 GiB, AOF `everysec`, `maxmemory` 8 GiB, `noeviction` | Streams (ingest queue, outbox) and the limiter. A cluster is not needed below about 100k ops/s; keys carry hash tags for the day it is |
| ClickHouse | 3 x 8 vCPU / 32 GiB, replicated (or ClickHouse Cloud, 2 nodes) | Optional: only for the secondary store (step 5) |
| Edge | Cloudflare zone with the Worker from `edge/`, a Queue `funnels-events` (+ DLQ), KV `ROUTES` | docs/CLOUDFLARE.md |
| Load generators | k6-operator, 8 pods x 2 vCPU in the same region as the origin (a second set in another region for the edge test) | Generators must not share nodes with the app |
| Observability | Prometheus (remote-write receiver on), Grafana | Dashboards from the metric names in RUNBOOK.md |

Terraform is deliberately not included: the three managed services differ per cloud. The app side is the kustomize overlay `deploy/k8s-scale/` (replicas, zone spread, rolling update with `maxUnavailable: 0`, HPA on CPU; `optional/keda-ingest-lag.yaml` scales on the ingest backlog) and the k6 TestRun in `deploy/k6/testrun.yaml`.

## 2. Prepare

1. Build and push the image; fill `deploy/k8s-scale/kustomization.yaml` (`images`) and the `funnels-secrets` Secret: `JWT_SECRET`, `DATABASE_URL` (via PgBouncer), `DATABASE_REPLICA_URLS`, `REDIS_URL`, `EDGE_SHARED_SECRET`, `CF_ORIGIN_SECRET`, `METRICS_TOKEN`.
2. `kubectl kustomize deploy/k8s-scale | kubectl apply -f -`; wait for `/readyz`. Migrations (001 to 009) run at boot under an advisory lock.
3. Seed: register one workspace per simulated tenant through the API (10 tenants for the noisy-neighbour test, 1 for the rest), create one live funnel per tenant on a real hostname behind the Worker, and record the `funnelId:stepId` pairs for k6 (`FUNNELS=fn_1:stp_1,...`).
4. Deploy the Worker with the queue binding enabled (`edge/wrangler.toml`, "Event queue" block) and `ORIGIN_URL` pointing at the app's ingress.
5. Apply `deploy/clickhouse/schema.sql` if running step 5.
6. Create the Grafana dashboard: request rate and p99 by route, `funnels_ingest_queue_lag`, `funnels_outbox_oldest_age_seconds`, event-loop lag, RSS per pod, PostgreSQL TPS / WAL / replication lag, Redis ops/s and memory, PgBouncer waiting clients.

## 3. Page serving (target 50,000 req/s at the edge, >= 99% hits)

```
kubectl create configmap k6-pages --from-file=pages.js=loadtest/k6/pages.js -n k6
# edit deploy/k6/testrun.yaml: script -> k6-pages/pages.js, env BASE_URL=https://offers.example.com, PATHS=/promo, TARGET_RPS=50000, parallelism=16
kubectl apply -f deploy/k6/testrun.yaml
```

Pass: `edge_cache_hit` > 0.99, `http_req_duration` p99 < 200 ms, origin `/internal/edge/resolve` rate (Prometheus, `route` label) below 2,000/s, `funnels_flights_total{outcome="leader"}` far below the request count. Then purge the page (save it in the builder) while the test runs and confirm the origin sees a bounded burst (one resolve per cache key per edge location, coalesced) and no errors.

| Metric | Target | Result |
|---|---|---|
| Edge req/s sustained | 50,000 | |
| Cache hit ratio | >= 99% | |
| p99 latency at the edge | < 200 ms | |
| Origin resolve req/s during warm-up and during a purge | < 2,000 | |
| Origin 5xx | 0 | |

## 4. Event ingestion (target 20,000 events/s sustained, 100,000/s peak)

```
# configmap from loadtest/k6/events.js, TARGET_RPS=20000, PEAK_RPS=100000, DURATION=15m, parallelism=8..16
kubectl apply -f deploy/k6/testrun.yaml
```

The script holds the arrival rate (open model), then ramps to the peak for two minutes and back. Pass criteria are the k6 thresholds (`http_req_failed` < 0.1% sustained, p99 < 300 ms, only 202 or deliberate 429/503 with `Retry-After` during the peak) **and** the correctness check after the run:

```sql
-- accepted events (k6 "http_reqs" with status 202) must equal rows, with no duplicate ids
SELECT count(*) FROM events WHERE created_at >= :start AND created_at < :end;
SELECT count(*) - count(DISTINCT id) AS duplicates FROM events WHERE created_at >= :start AND created_at < :end;
SELECT sum(page_views) FROM event_rollups WHERE bucket >= :start AND bucket < :end;   -- equals the first count
```

Repeat once while killing things (one at a time, with k6 running): `kubectl delete pod --force` on one app pod; `redis-cli DEBUG SLEEP 20` (or fail over the Redis primary); a PostgreSQL failover; scale the app to zero for 2 minutes. Lost = accepted minus rows must be 0 after the backlog drains (`funnels_ingest_queue_lag` back to 0); the allowed exception is the Redis failover with asynchronous replication, where the last second of acknowledged writes can be lost: record how many.

| Metric | Target | Result |
|---|---|---|
| Sustained accepted events/s | 20,000 | |
| p99 accept latency at sustained | < 300 ms | |
| Peak absorbed (events/s) and what happened above it (503 count, queue lag peak) | 100,000 | |
| Time to drain the backlog after the peak | n/a (record) | |
| Rows written/s by the consumers (PostgreSQL, whole cluster) | >= 20,000 | |
| Lost / duplicated after pod kill | 0 / 0 | |
| Lost / duplicated after Redis failover | record | |
| Lost / duplicated after PostgreSQL failover | 0 / 0 | |
| App pods needed; PostgreSQL CPU and WAL MB/s at 20,000/s | record | |

## 5. ClickHouse secondary store (optional)

Enable `EVENTSTORE_MIRROR=clickhouse` with `CLICKHOUSE_URL`, repeat step 4 for 10 minutes, then compare `SELECT count() FROM funnels.events FINAL` with the PostgreSQL row count for the same window and `sum(page_views)` from `event_rollups_15m` with `event_rollups`. They must be equal. Then re-run a window's backfill (`scripts/backfill-clickhouse.ts --from ... --to ...`) and confirm the rollup sums did not change: this is the check that block deduplication stops materialised views double counting on replay, which this repository could not test (no ClickHouse server was available). If it fails, the ClickHouse rollups are not safe under replay: use `argMax`/`FINAL` queries on `events` instead and drop the views.

## 6. Analytics reads and data volume

Load 1B events (the generator in `bench/volume.mjs` scaled up, or replay step 4 for hours into a pre-partitioned table), then:

```
k6 run -e BASE_URL=... -e TOKEN=... -e FUNNELS=fn_1 -e TARGET_RPS=50 loadtest/k6/analytics.js
```

and run `EXPLAIN (ANALYZE, BUFFERS)` for the analytics queries as shown in SCALING.md ("Data volume") to prove partition pruning at that size.

| Metric | Target | Result |
|---|---|---|
| Analytics p95, 7 / 45 / 288 day ranges | < 300 ms | |
| Partitions scanned for a 7-day range | 1 or 2 | |
| Insert rate into the partitioned table at 1B rows (rows/s per primary) | >= 20,000 | |
| Table + index size per 1M events | record (laptop: see SCALING.md) | |

## 7. Noisy neighbour

10 tenants, 90% of the traffic on tenant 1 at 100x the others (`HEAVY_SHARE=0.9`), `TARGET_RPS=20000`. Then run the same load with `HEAVY_SHARE=0` and compare the other nine tenants' accept latency (k6 tag `funnel:other`) and time-to-visible in analytics. Pass: the other tenants' p99 changes by less than 20% and none of them is shed. Expected shape, from the design rather than from a measurement: the heavy tenant is limited first by `public.events` (per IP and funnel) and per-workspace tier limits, then by `INGEST_MAX_LAG` for everyone, so check that the per-tenant limits bite before the global one does.

## 8. Cost (rough, order of magnitude)

Assumptions: one region, on-demand list prices as the author remembers them (verify against the current price lists before using any of this), 730 h/month, no committed-use discounts, traffic at the sustained target 24x7 (20,000 events/s is 1.7 billion events/day, which is far above what most deployments see; scale linearly for real traffic).

| Item | Quantity | Approx. $/month |
|---|---|---|
| App nodes (c-class, 8 x 2 vCPU/2 GiB, 24 vCPU peak) | 8 pods, about 4 nodes of 8 vCPU | 600 to 900 |
| PostgreSQL primary 16 vCPU / 64 GiB + 2 replicas 8 vCPU | managed | 3,000 to 5,000 |
| Storage for 1.7B events/day retained 30 days (274 B/row incl. indexes, measured in SCALING.md) | about 14 TB at the measured 274 B/event | 2,000 to 4,000 (more with replicas and backups) |
| Redis 16 GiB with replica | managed | 400 to 700 |
| ClickHouse 3 x 8 vCPU / 32 GiB (optional) | | 1,500 to 2,500 |
| Cloudflare Workers + Queues at 1.7B events/day | queue operations dominate (each event is 3 operations: write, read, ack) | about 2,000 to 3,000 |
| Observability, egress, load generators during tests | | 500 to 1,500 |

Total: roughly 10,000 to 18,000 USD per month at the full sustained target, dominated by storage and the edge queue. At 1% of that traffic (200 events/s, 17M/day) the same architecture runs on a small primary and 2 app pods for a few hundred dollars. The Cloudflare Queues figure is the least certain; if it is too high, send events to the origin directly (the Worker falls back to that when `EVENTS_QUEUE` is unbound) and rely on the origin ingest queue for absorption.

## 9. Clean up

`kubectl delete -f deploy/k6/testrun.yaml`, scale the app down, drop the load-test database or snapshot and delete it, empty the Cloudflare Queue and DLQ, delete the generators' node pool.
