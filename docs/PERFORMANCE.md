# Performance

Machine: Apple M1 (8 cores), 8 GB RAM, macOS, Node v24.11.1, everything on loopback. The load generator runs on the same machine and competes with the server for CPU, so numbers are a lower bound for the server and say nothing about network behaviour. Reproduce with `npm run build`, then `node loadtest/run.mjs 10`, `node bench/analytics.mjs 1000000`, `node bench/render.mjs`.

## What changed and why

| Change | Where |
|---|---|
| Analytics read from 15-minute rollups (trigger-maintained) instead of scanning `events` | `002_perf_edge.sql`, `services/analytics.ts` |
| Write-behind buffer for `POST /api/public/events` (batched transactions, bounded queue, flush on timer/overflow/shutdown/read) | `services/eventbuffer.ts` |
| Prepared-statement cache (bounded, by SQL text) | `db/db.ts` |
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
* Not run: Redis/Postgres variants, k6, multi-node.

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

## Single-node ceiling and what scaling would take

SQLite WAL with one writer, in-memory rate limiter, SSE bus and page cache: run one replica (see `deploy/k8s`). Moving to several nodes needs a shared database (the services call the synchronous `node:sqlite` API directly, so this is a rewrite of the data layer, not a driver swap), a shared limiter, and cache-invalidation fan-out. That work (PostgreSQL, Redis, BullMQ) was **not** done.
