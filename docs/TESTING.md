# Testing

Vitest in both packages. Server tests are HTTP integration tests through `app.request()` with injected fakes (clock, DNS resolver, HTTP client, host lookup, AI provider). No test touches the network. The whole server suite runs against every database backend (below).

```
npm test                  # server + web
npm test --prefix server  # whole suite on SQLite AND PGlite (~480 tests each), about 80 s
npm test --prefix web     # ~50 tests (jsdom + Testing Library)
npm run typecheck         # tsc --noEmit in both packages
npm run build             # tsc + vite build
```

### Database matrix

`TEST_DB` picks the engine(s); the Vitest config turns each into a project that runs every `test/**/*.test.ts` file:

| `TEST_DB` | Engine | Notes |
|---|---|---|
| `both` (default) | SQLite `:memory:` + PGlite | `npm test` |
| `sqlite` | `node:sqlite` in memory | ~6 s |
| `pglite` | `@electric-sql/pglite` (PostgreSQL 18 in WASM, in process) | ~55 s; one instance per worker is reused and `TRUNCATE`d between tests because booting one costs ~1 s |
| `pg` | a real server at `TEST_PG_URL` (`postgres://user:pass@host:5432/db`) | one throwaway database per worker process; this is what the `test-postgres` CI job runs on `postgres:17` |

`makeHarness()` is async because the database is. PGlite has one connection, so it proves dialect correctness but not multi-connection behaviour; `test/pg-real.test.ts` (skipped unless `TEST_PG_URL` is set) covers that: parallel saves/duplicates/reorders/domain attach/submissions/rate limit/AI cap on a pool of 12 connections, a forced deadlock that must be retried transparently, `SKIP LOCKED` job claiming, concurrent migration runs, and no leaked connections.

Rate limiter tests: `ratelimit.algo.test.ts` (GCRA/window/lease/penalty on an injected clock, property tests with fast-check), `ratelimit.redis.test.ts` (a real `redis-server` started per run: 1,000 concurrent calls over 8 connections and 4 OS processes admit exactly the burst, memory/Redis equivalence on random sequences, `SCRIPT FLUSH` recovery, TTLs and hash tags, clock skew, outage, circuit breaker, timeout budget, lease tier), `ratelimit.cluster.test.ts` (3 server processes sharing one Redis), `ratelimit.http.test.ts` (headers, 429/503 bodies, route declaration coverage, authz matrix, tiers, admin hooks, lockout, IP matrix). They skip when no `redis-server` binary is found (`REDIS_SERVER_BIN` overrides the lookup); CI installs it.

Scale tests: `eventbus.test.ts` (one contract suite against the in-memory bus and Redis Streams on a real `redis-server`: order per key, consumer groups, late subscribers, competing consumers, retry, dead letters, batch handlers, lag, takeover, and a child process killed with SIGKILL whose unacknowledged entries are redelivered; Kafka/NATS stubs fail loudly), `queue.test.ts` (ingest queue, outbox, mirror, ClickHouse wire format against a fake HTTP server, the signed `/internal/edge/events` endpoint), `hll.test.ts` (sketch accuracy and merge), the concurrency case in `pg-real.test.ts`. Run the PostgreSQL ones with `TEST_PG_URL=postgres://... TEST_DB=pg npx vitest run --project pg`. Load and failure harnesses (not part of `npm test`): `loadtest/scale.mjs`, `loadtest/suite-scale.sh`, `bench/volume.mjs`, k6 scripts in `loadtest/k6/`; results and how to read them in [SCALING.md](SCALING.md).

Access-control tests: `rbac.policy.test.ts` (the central policy: every route declares a permission, no dead permissions, the pinned list of `any` routes, and a generated matrix that calls every authenticated route with a role holding everything except its permission and with a role holding only it), `rbac.test.ts` (custom roles, escalation rules, last owner, tenancy of roles), `sessions.test.ts` (rotation, theft detection, the two-tab race, expiry and session cap, revocation everywhere), `invitations.test.ts` (invitations and password reset), `twofactor.test.ts` (RFC 6238 and 4226 vectors, enrolment, replay, recovery codes, lockout, admin recovery), `audit.test.ts`.

Docs tests: `docs.test.ts` (`npm run docs:check`): links and anchors, index, config coverage, stale generated files, OpenAPI coverage of every route, Mermaid parse, changelog, runnable examples in API.md.

Data-layer tests: `db.test.ts` (migrations, constraints and error mapping, transactions, savepoints, handle misuse, queueing behind a transaction, every dialect helper executed on the live engine), `schema-equivalence.test.ts` (introspects SQLite and PostgreSQL and diffs tables, columns, indexes), `pg-driver.test.ts` (the `pg` Pool code path on a scripted pool: SQL text, isolation level, COMMIT/ROLLBACK, savepoints, retry on 40001/40P01, statement naming, connection release), `no-direct-sqlite.test.ts` (no driver import, `.raw`, or SQLite-only SQL outside `src/db/`).

Test helpers (`server/test/helpers.ts`): `makeHarness()` builds an app with a controllable clock (`FakeClock`), `FakeDns`, `FakeHttp`; `register`, `member`, `activeDomain`, `makeFunnel`, `fromTemplate`, `formTarget`, `checkoutTarget` set up common worlds.

## Edge-case catalogue (server)

| Area | File | Covered |
|---|---|---|
| Renderer XSS | `blocks.render.test.ts` | script tags, attribute injection, `javascript:`/`data:`/tab-split/fullwidth URLs, CSS injection, unicode, empty doc, unknown block, 400-block limit, nesting limit, columns cap, determinism |
| Sanitiser and schema | `blocks.sanitize-schema.test.ts` | handlers, entity/whitespace URL tricks, malformed nesting, style filtering, hostile 50,000-deep JSON, versions |
| Paths | `steps.test.ts` | accept/reject table, intra-funnel and cross-funnel collisions, `/path-NNNN` suggestions, resolution subset validation, create-with-domain |
| Reorder | `steps.test.ts` | duplicate ids/orders, partial set, foreign ids, bad numbers, gap normalisation, link re-render |
| State machine | `funnels.test.ts`, `domains.test.ts` | live needs active domain, test detaches, domain loss/deletion revert in one transaction, rollback when the delete or the status update fails (a trigger injects the failure, written per dialect by `failOn`) |
| Versions | `pages.test.ts` | pruning at exactly 10/11, per step, autosave exempt, restore creates a backup, version conflicts, scripts policy |
| Funnels | `funnels.test.ts` | search/filters/sort/pagination, stats, duplicate naming, soft delete/restore/purge, tag case-insensitivity and scoping |
| Tenancy and roles | `tenancy.test.ts`, `auth.test.ts` | 404 for every resource type, no existence leak, role matrix, instant role changes |
| Public events | `public.test.ts` | unknown/deleted funnel, malformed, oversized (413), bots, duplicate idempotency, rate limit 429 + Retry-After |
| Forms and orders | `public.test.ts`, `exports.test.ts` | lead dedupe, honeypot, field validation, idempotent checkout, bump/upsell, decline, CSV injection |
| Analytics | `analytics.test.ts` | zero visits, rounding, inclusive range edges, time-zone and DST day boundaries, series |
| Webhooks | `webhooks.test.ts` | signature, backoff schedule, dead letter, SSRF table (v4/v6/mapped/NAT64/decimal/octal), DNS rebinding, redirects not followed |
| Preview and serving | `serving.test.ts` | token expiry/tamper/cross-funnel/cross-workspace, ETag/304, cookies and UTM sanitising, 301/home/404 rules, host matching |
| AI | `ai.test.ts` | invalid JSON, schema mismatch, empty, throws, refusal, truncation, prompt injection, fallback, invented numbers, rate limit and daily cap |
| DNS | `domains.test.ts` | pending/active/failed transitions, resolver errors, timeout, job polling with backoff |

## Web tests

`builder.test.ts` (undo/redo reducer, coalescing, dirty tracking, tree operations, serialisation round trip), `components.test.tsx` (block inspector, keyboard reorder of steps with rollback, API error display, login validation, modal focus trap, toasts), `pages.test.ts` (reorder model, validators, settings patch, chart helpers), `api/client.test.ts`.

## Not covered

Real browsers (drag and drop, the sandboxed canvas script), real DNS, real Anthropic calls, concurrent multi-process access to the SQLite file, Redis, PostgreSQL versions other than 17 (CI) and 18 (PGlite and the local verification run), PostgreSQL behind a connection pooler such as pgbouncer in transaction mode (named prepared statements would need to be disabled there).

## Phase 2 additions

`server/test/phase2.test.ts` covers the edge signing contract (skew, replay, fail-closed), the edge endpoint, purge jobs and the Cloudflare adapters (mocked `fetch`), CF-Connecting-IP trust, the event buffer (batching, overflow, shutdown flush, read-your-writes), batched rollup maintenance (compared with a raw `GROUP BY` per local day in UTC, New York, Kolkata and Auckland), `EXPLAIN` index checks on every engine (PostgreSQL runs them with sequential scans disabled), an N+1 guard, gzip/metrics, 2,600-row streaming CSV, and `Promise.all` concurrency tests: same-version saves (one winner), parallel duplicates/reorders/domain attach, parallel identical submissions and exact rate limiting. `edge/test/edge.test.ts` tests the worker with fake Cache/KV, verifying each signed call with the origin's real verifier. These run in the normal `npm test` (about 480 server tests per backend, 14 edge tests, 51 web tests). Not covered: workerd/miniflare, Redis.

## Browser smoke tests (Playwright)

`e2e/` drives real Chromium against the **built** server serving the **built** web app (`npm run build` first), with an in-memory SQLite database and a fake DNS resolver (`e2e/server.mjs`, so `*.e2e.test` domains can be verified; the browser maps that suffix to 127.0.0.1). Run: `npm run e2e:install` once (downloads Chromium, about 100 MB), then `npm run e2e` (about 40 s). One worker, no retries (a retry would hide flakiness); traces and screenshots are kept for failures (`npx playwright show-trace e2e/test-results/.../trace.zip`). CI job `e2e` runs it and uploads the report on failure.

| Test | What it proves |
|---|---|
| register, sign out, sign in | auth screens and session handling |
| funnel from a template; steps reorder with Alt+Arrow | template gallery, steps tab, keyboard reorder persisted on the server |
| canvas click selects a block | the builder canvas script is not blocked by the app CSP (regression for a real bug the unit tests could not see) |
| edit, undo, redo, save, reload | builder state, save, persistence |
| structure list reorder by keyboard and by drag and drop | both reorder paths in the real DOM |
| Save keeps the replaced version; History lists, previews and restores it | version history |
| signed preview and form submit | preview rendering; preview submissions are intentionally not recorded |
| live funnel on a verified domain, visitor submits the form | domain add and verify, go live, public serving by Host header, form submit, lead in the Leads tab, analytics tab |
| analytics tab renders | no console or page errors |
| invite a viewer by email (`access.spec.ts`) | the permission picker-free invite flow, accept page, the signed-in role in the UI, UI gating (no "Add domain", no "Invite member") **and** the server refusing the same action sent directly (403 naming the permission), the audit log page |
| custom role | build a role with the permission picker, assign it through an invitation, and the member can exactly what the role grants |
| two-factor authentication | enrol with a code computed from the setup key, recovery codes shown once, sign-in needs the code (wrong code refused), a recovery code works once |
| forgotten password | the emailed link (read from the e2e server's capture mailer), new password works, old one does not, another browser's session ends |
| expired access token | an access token the server rejects is renewed from the refresh token in the background |

Not covered (yet): checkout, the AI assistant UI, webhooks UI, mobile layouts, other browsers (Firefox, WebKit are not installed), accessibility audits beyond role-based selectors.

## Stripe tests

`server/test/stripe.test.ts` (29 tests, all engines) runs against `server/test/support/fakestripe.ts`: signature scheme (rotation, replay), Connect onboarding and webhooks, hosted checkout parameters and fee by plan, webhook and return-URL race creating orders once, amount mismatch retry, Stripe outage, upsell success/decline/authentication/idempotency, refunds (partial, concurrent, Stripe failure, permissions, dashboard reconciliation), subscriptions and plan limits. A fake cannot prove Stripe's real behaviour: see the checklist in [STRIPE.md](STRIPE.md).

## Admin tests

`server/test/admin.test.ts` (20 tests, all engines): every platform route refuses anonymous callers and ordinary owners (generated from the route declaration), administrator bootstrap and removal rules, mandatory 2FA (and the production forcing in `loadConfig`), workspace search and paging, suspension across every surface (serving, sessions, API keys, public writes, previews, edge purge job, reversal, other workspaces unaffected), impersonation (expiry on the fake clock, forbidden routes, audit in the workspace's log, no admin targets), flags (overrides, stable monotone rollout over 400 sample workspaces), queue inspector, GDPR export and erasure (books still add up, no address left in scrubbed tables or audit), workspace export (2300 rows across pages), deletion guard rails and cascade, announcements, platform audit.
