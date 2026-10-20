# Performance

Machine: Apple M1 (8 cores), 8 GB RAM, macOS, Node v24.11.1, everything on loopback. The load generator runs on the same machine and competes with the server for CPU, so numbers are a lower bound for the server and say nothing about network behaviour. Reproduce with `npm run build`, then `node loadtest/run.mjs 10`, `node bench/analytics.mjs 1000000`, `node bench/render.mjs`.

## What changed and why

| Change | Where |
|---|---|
| Analytics read from 15-minute rollups instead of scanning `events`; maintained by the application once per batch (was: a SQLite trigger per row until migration 004) | `services/rollups.ts`, `services/analytics.ts` |
| Write-behind buffer for `POST /api/public/events` (batched transactions, bounded queue, flush on timer/overflow/shutdown/read) | `services/eventbuffer.ts` |
| Prepared-statement cache (bounded, by SQL text; named server-side statements on PostgreSQL) | `db/sqlite.ts`, `db/pg.ts` |
| Keyset-paged streaming CSV exports (1000 rows per page, no 50,000-row cap) | `util/csv.ts` |
| gzip/deflate for pages and JSON (not SSE) | `app.ts` |
| Rendered-page LRU keyed by step, invalidated on writes; `ETag` = content checksum, 304 | `util/pagecache.ts`, `routes/serve.ts` |
| Bundle splitting: lazy routes, builder + renderer in their own chunks; budget script in CI | `web/src/App.tsx`, `web/scripts/check-bundle-size.mjs` |
| Index checks and N+1 guard as tests | `test/phase2.test.ts` |

## Analytics: before / after (1,000,000 events, one funnel, 4 steps, 30-day range)

| Query | Raw scan (before) | Rollups (after) |
|---|---|---|
| per-step totals | 163.8 ms | 3.4 ms |
| daily series input | 215.7 ms | 2.8 ms |
| `COUNT(DISTINCT visitor)` for funnel-level uniques | 115.1 ms | unchanged (needs raw events) |

Results were verified identical (`results identical: true`). Inserting 1M events with the trigger active took 35.3 s in one transaction (about 28k rows/s, synchronous=OFF in the benchmark). The rollup table held 34,560 rows for those 1M events. Buckets are 15 minutes because every real time-zone offset is a multiple of 15 minutes, so a local-day boundary never splits a bucket (tests cover New York, Kolkata and a DST day in Berlin).

## HTTP load (built server, 10 s per scenario)

| scenario | req/s | p50 ms | p97.5 ms | p99 ms | max ms | errors | non-2xx | RSS MB before → after |
|---|---|---|---|---|---|---|---|---|
| public page, origin hit (64 conn) | 10,709 | 5 | 11 | 18 | 242 | 0 | 0 | 116 → 161 |
| public page, gzip (64 conn) | 5,974 | 10 | 14 | 16 | 141 | 0 | 0 | 161 → 305 |
| page_view ingestion, unique visitors (64 conc) | 4,244 | 11.8 | 57.4 | 63.1 | 147 | 0 | 0 (all 202) | 305 → 328 |
| mixed admin: list, analytics, steps, leads (32 conn) | 351 | 85 | 164 | 191 | 761 | 0 | 0 | 328 → 216 |
| builder save, 16 clients on the same base version | 5,852 | 2 | 4 | 7 | 107 | 0 | 64,364 | 216 → 205 |
| opt-in form submissions, distinct emails (32 conc) | 2,026 | 15.6 | 30.1 | 51 | 106 | 0 | 0 | 205 → 243 |

Integrity after the run: analytics reported 42,439 page views and the raw table held 42,439 (every accepted request was counted after the shutdown flush).

Reading the numbers honestly:

* Page serving is a prepared-statement lookup plus an LRU hit; 10k rps on one core is the origin-without-CDN ceiling here. With the worker in front, most requests never reach it. gzip halves throughput (CPU) and raised RSS; at the edge compression is free, so keep it for non-Cloudflare deployments only.
* Ingestion with the buffer on: 4,244 rps against 3,309 rps with `EVENT_BUFFER_MS=0` (write-through) in a shorter 6 s run. The gain is modest because the Node `fetch` client is itself near saturation and each request still pays rate limiting, JSON parsing and a funnel/step lookup. Treat it as "buffering is not slower and batches commits", not as a tenfold win.
* The mixed admin scenario ran after 40k+ events existed. It is dominated by the funnel-level `COUNT(DISTINCT visitor_id)` in the analytics endpoint (about 115 ms per call at 1M events in the benchmark). That is the next thing to optimise (a per-funnel HyperLogLog or a daily distinct-visitor table).
* Builder save contention: one 200, every other request 409 with `VERSION_CONFLICT` and `currentVersion`; no 5xx, no lost update. Conflict policy: optimistic concurrency on the step `version`; the client reloads and re-applies.
* Rate-limit correctness under load is asserted exactly by tests (60 parallel requests against a 20/min limit give exactly 20 x 202 and 40 x 429).
* The scenario "page cache hit vs miss" is not separate: the origin LRU is hot after the first request. Edge cache hit rates depend on Cloudflare and were not measured.
* Not run: Redis variants, k6, multi-node.

## Worker threads: measured, not adopted

| Function (hard-limit input) | median | p95 |
|---|---|---|
| `renderPage`, 400 blocks | 0.89 ms | 1.27 ms |
| `parseDocument` (zod), 400 blocks | 0.70 ms | 1.33 ms |
| `sanitizeHtml`, 47 KB | 1.80 ms | 2.25 ms |
| CSV formatting, 1000 rows | 0.28 ms | 0.31 ms |

The input limits (400 blocks, 50 KB HTML, 1.5 MB document) keep every CPU-bound step under a few milliseconds, which is less than the cost of posting the work to a thread. Exports are already streamed in pages, so the event loop is released between pages. A `worker_threads` pool and Web Workers for the builder were therefore **not** added; revisit if the limits are raised.

## Ingestion semantics to know

The buffer trades a bounded window (default 250 ms, 5,000 rows) of crash exposure for fewer commits. `SIGTERM` flushes; a hard kill can lose the unflushed window. Readers that need exact numbers call `flush()` first. Duplicate opt-in ids and first-view uniqueness are decided against both stored and still-queued rows.

## Single-node ceiling and what scaling takes

SQLite (WAL, one writer) keeps the single-replica limit. With `DATABASE_URL` the data layer is multi-connection safe (see ARCHITECTURE.md, Data layer), but the in-memory limiter, page cache, SSE bus and the event buffer's uniqueness sets are still per process. Redis/BullMQ work is separate and not done.

## Regression investigation: ingestion 4,244 req/s then 914 req/s

Claim under test: migration `003_visitor_days.sql` (a second per-row trigger) cut ingestion from about 4,244 to about 914 req/s. The two earlier figures were not comparable (9k vs 42k events in the table, a shared machine), so both were re-measured here.

Machine for everything below: Apple M1, 8 cores, 8 GB, macOS, Node v24.11.1, 2026-10-19. **The machine was not quiet.** Load average was 8 to 28 throughout (Spotlight indexing and other agents' processes; I could not stop them), so absolute numbers and any single run are unreliable. What is reported are medians of interleaved repeats, which share the same drift, plus a no-HTTP benchmark that removes most of it.

**1. HTTP, fixed 30,000 requests (identical data volume), 64 concurrent unique visitors, built server, `bench/ingest.mjs`, 5 interleaved rounds, median:**

| variant | req/s | server CPU ms per 1k requests |
|---|---|---|
| before: both triggers (commit 4bfea23) | 2,953 | 380 |
| before, both triggers removed (no rollups at all) | 3,134 | 387 |
| after: batch + app-level rollups (this change) | 3,209 | 356 |

Per-round req/s ranged 1,656 to 3,516 (before) and 574 to 4,280 (no triggers): the spread between rounds is larger than the difference between variants, so **HTTP-level differences of under about 10% are not resolvable on this machine**. A first 3-round attempt was worse (788 to 2,447 req/s) for the same reason.

**2. Write path only, no HTTP, `bench/ingest-db.mjs` (50,000 events in batches of 500, 5 interleaved repeats, median / min):**

| strategy | wall ms per 1k rows | CPU ms per 1k rows |
|---|---|---|
| per-row insert + both triggers (before) | 43.7 / 38.9 | 39.4 / 36.7 |
| per-row insert + rollup trigger only | 27.6 / 24.6 | 24.9 / 23.2 |
| per-row insert, no triggers (lower bound, no rollups) | 9.2 / 8.4 | 8.6 / 8.0 |
| batch insert + app-level rollups (after) | 13.1 / 11.8 | 12.6 / 11.0 |

**Finding.** The triggers are expensive for what they do (the `visitor_days` trigger alone added about 16 ms per 1k rows, +58% over the rollup trigger; the rollup trigger added about 18 ms, 3x the bare insert), but in absolute terms they cost about 0.035 ms per event against about 0.38 ms of server CPU per request: roughly 10% of an ingestion request. **They do not explain a 4.6x throughput drop.** The 914 req/s run coincided with a loaded machine, a 4x larger table (the first-view lookup uses an index whose depth grows) and a benchmark running at the same time; that is the most likely cause, and it cannot be proven after the fact.

**Resolution.**
* Rollup maintenance moved from a per-row trigger to the batch flush: one multi-row insert plus one upsert per (funnel, bucket, step) per batch, in the same transaction. Write cost 43.7 to 13.1 ms per 1k rows (3.3x less) and only 1.4x the no-rollup lower bound. Exactness is tested against a raw `GROUP BY` per local day for UTC, New York, Kolkata and Auckland (`phase2.test.ts`), and `analytics.test.ts` covers DST and edge days.
* `visitor_days` removed (migration 004). It saved about 30 ms on the 1M-event distinct count (109 vs 140 ms in the quiet run) for +58% write cost and about 190k extra rows per million events, and it did not pay for itself. Funnel-level distinct visitors are a raw `COUNT(DISTINCT visitor_id)` again.

## Final benchmark suite (after this change)

`node bench/analytics.mjs 1000000` (1M events, one funnel, 4 steps, 30-day range; machine loaded, so about 1.6x slower than the earlier quiet run; the rollup-vs-scan ratio is what matters):

| Query | Raw scan | Rollups |
|---|---|---|
| per-step totals | 269.7 ms | 4.2 ms |
| daily series input | 315.3 ms | 3.6 ms |
| `COUNT(DISTINCT visitor)` | 220.2 ms | not applicable (needs raw events) |

Results identical (`results identical: true`). 1M events inserted in 8.7 s in one transaction with no triggers, then rolled up with one `GROUP BY` (34,560 rollup rows).

`node loadtest/run.mjs 10` against the built server on SQLite, three runs (before = commit 4bfea23, one run, same session):

| scenario | before (1 run) | after run 1 | run 2 | run 3 | median after |
|---|---|---|---|---|---|
| public page, origin hit, 64 conn (req/s) | n/a | 9,516 | n/a | n/a | 9,516 (1 run) |
| page_view ingestion, 64 conc | 2,904 | 1,055 | 1,666 | 2,401 | 1,666 |
| mixed admin, 32 conn | 597 | 603 | 450 | 400 | 450 |
| builder save, 16 conn on one base version (409 count in brackets) | 4,022 | 3,351 (33,501) | 4,685 (46,839) | 5,567 (61,237) | 4,685 |
| opt-in submissions, 32 conc | 1,405 | 1,878 | 1,930 | 2,275 | 1,930 |

Reading this honestly: the three "after" runs of the same code differ by 2x for ingestion, so the loaded machine decides the result; I cannot claim that after is faster or slower than before at HTTP level. Builder saves still yield exactly one 200 per run (everything else 409, no 5xx), and event integrity held in every run (analytics page views equal raw rows after the shutdown flush). The first run of the earlier table in this file (4,244 req/s ingestion, 351 mixed) was measured on a quieter machine and should not be compared with these.

Write path per engine (`bench/ingest-engines.mjs`, 50,000 events in batches of 500, median of 3): SQLite 10.3 ms per 1k rows (97k rows/s), PGlite 47.3 (21k rows/s), PostgreSQL 18.4 over loopback 31.0 (32k rows/s). The PostgreSQL figure is a `postgres` binary from the `embedded-postgres` npm package running x86_64 under Rosetta on this ARM Mac, so it understates a native server; it is shown to prove the path works on a real server, not as a capacity number. HTTP load tests cannot run against PGlite (no TCP) and were not run against PostgreSQL: Docker is down here and the server used for verification was a development binary.

Not run: the HTTP suite against PostgreSQL, k6, multi-node, a native or containerised `postgres:17`.

## Rate limiter overhead (2026-10-20)

Same machine as above (M1, 8 cores, 8 GB, Node 24, load average 8 to 21 from other processes), Redis 8.4.0 on loopback, same process tree as the app. Reproduce: `npm run build --prefix server && node bench/ratelimit.mjs 20000 <concurrency> <hotClients>`.

**Per request, no HTTP** (`bench/ratelimit.mjs`: the two layers an ingestion request passes, `ip.global` + `public.events`; "added" is the wall time of the limiter calls):

| scenario | variant | requests/s | p50 added | p99 added | Redis round trips per request |
|---|---|---|---|---|---|
| 1 in flight, every request a new client | disabled | 752,121 | 0.001 ms | 0.005 ms | 0 |
| | in-memory store | 194,164 | 0.004 ms | 0.008 ms | 0 |
| | Redis, exact | 5,808 | 0.163 ms | 0.301 ms | 2.00 |
| | Redis + lease | 5,570 | 0.169 ms | 0.373 ms | 2.00 |
| 64 in flight, every request a new client | in-memory store | 211,803 | 0.270 ms | 1.130 ms | 0 |
| | Redis, exact | 20,310 | 2.883 ms | 5.932 ms | 2.00 |
| | Redis + lease | 16,696 | 3.430 ms | 7.967 ms | 2.00 |
| 64 in flight, 50 hot clients | in-memory store | 200,038 | 0.264 ms | 1.437 ms | 0 |
| | Redis, exact | 8,969 | 6.090 ms | 21.578 ms | 2.00 |
| | Redis + lease (10%) | 159,642 | 0.300 ms | 2.139 ms | 0.01 |

Reading it: one round trip to a local Redis costs about 0.08 ms, so a request with two layers adds about 0.16 ms (p99 0.3 ms) when it is the only thing in flight. The "64 in flight" latencies are queueing on one Redis connection, not per-call cost. The lease tier only helps keys that repeat (hot clients: 99% of decisions served locally, 0.01 round trips per request); for a stream of never-seen clients it cannot help and costs a little extra (a batch is pre-paid for one use). Network distance matters more than anything here: with Redis 1 ms away, every exact decision adds about 2 ms per layer, which is the reason the lease tier exists.

**Through HTTP** (`bench/ingest.mjs`, 30,000 `POST /api/public/events`, 64 concurrent, one client IP, so a hot key; 5 interleaved rounds, median; machine loaded):

| limiter | req/s | server CPU ms per 1k requests |
|---|---|---|
| disabled (`RATELIMIT_ENABLED=false`) | 2,960 | 444 |
| in-memory | 2,567 | 501 |
| Redis + lease | 2,741 | 476 |
| Redis exact | 2,266 | 551 |

Round-to-round spread (753 to 3,237 req/s for "disabled") is larger than the differences, so the honest reading is: the in-memory and leased limiters are within noise of no limiter at this level (about 30 to 60 CPU ms per 1k requests, 7 to 13%), exact Redis costs about 25% more CPU per request than disabled (two round trips with awaits). One outlier round (84 req/s, 3 errors, redis-exact round 1) coincided with leftover Redis test processes on the machine and is included in the medians' input but not their result.

**Correctness at scale** (tests, not benchmarks): 1,000 concurrent calls over 8 connections and 4 OS processes admit exactly the burst; 3 server processes sharing one Redis admit burst plus refill and never more; the lease tier strands at most `nodes x lease` tokens (measured: a bug where concurrent refills each pre-paid a batch admitted only a third of the burst; fixed with a single-flight refill, covered by `ratelimit.cluster.test.ts`).
