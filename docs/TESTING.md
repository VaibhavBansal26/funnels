# Testing

Vitest in both packages. Server tests are HTTP integration tests through `app.request()` with injected fakes (clock, DNS resolver, HTTP client, host lookup, AI provider). No test touches the network. The whole server suite runs against every database backend (below).

```
npm test                  # server + web
npm test --prefix server  # whole suite on SQLite AND PGlite (892 tests on SQLite, 1,687 across both, 2026-10-20), about 4 minutes while other work runs, 80 s alone
npm test --prefix web     # 112 tests (jsdom + Testing Library)
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
| Page cleaning and XSS | `pagemodel.xss.test.ts` (49) | about 40 OWASP-style payloads pushed through every attacker-controlled entry point (text, attributes, typed props, custom code, style rules, link and image URLs) with the rendered page parsed by jsdom for anything executable; CSS filtering (`expression()`, `behavior`, `-moz-binding`, foreign `url()` and `@import`); structure cleaning from allow-lists; idempotence (the rendered output of a hostile page equals that of its cleaned form); custom code for permitted and non-permitted savers; page CSS and tracking code; form actions always point at the app |
| Limits, contrast, component versions | `pagemodel.limits.test.ts` (26) | element, depth, byte and rule limits (named in the message; pathological depth does not overflow the stack), oversized text truncated, unknown versions and invalid typed props refused with a path, duplicate or missing form and product ids repaired, video sources, WCAG AA contrast of the theme colours, seeded templates never setting their own text colour, the converter dropping dark-on-dark text colours, component version reconciliation |
| Renderer | `pagemodel.render.test.ts` (25) | determinism, empty and garbage projects, beacon in live and preview mode, accessible structure (skip link, landmark, labelled controls), responsive CSS and reduced motion, media-query order, the element limit, escaping and URL schemes, every component (button actions, video allow-list, FAQ, tabs and popups, countdowns, forms with honeypot and consent, checkout with bump and upsell from validated products, currencies), page variables, custom API base for customer domains |
| Converter | `pagemodel.convert.test.ts` (11) | every block type, form and checkout ids kept, columns and ratios, loose blocks, page settings, button actions and step remapping, unknown blocks and malformed values (never throws), determinism and idempotence, AI generated funnels, every seeded template |
| Page API | `pagemodel.api.test.ts` (15) | the server derives `forms` and `products` and renders from the project only; client-supplied HTML, CSS, forms and products are ignored (a tampered price never reaches a buyer); validation errors name the component and store nothing; 413 above the size limit; optimistic concurrency, newest-10 backups, restore and autosave; legacy pages converted on first open with the original kept; the start-up migration (idempotent, re-renders published HTML); seeding; legacy backups listed and restored; the old API body still accepted; the custom code permission rule; sandboxed previews and no editor chrome in published HTML; `/html` endpoints scoped to the workspace |
| Images | `assets.test.ts` (6) | PNG, JPEG, GIF and WebP stored by content and served publicly with hardened headers; raw-body uploads; anything that is not a raster refused whatever its name or declared type says (SVG, HTML, scripts, polyglots); per-workspace limit and permission; URL-safe names; reachable on customer domains |
| Legacy block schema and URL rules | `blocks.schema.test.ts` (11) | what the legacy input path still accepts and refuses (schema, URL and colour safety); only the converter reads these documents now |
| Paths | `steps.test.ts` | accept/reject table, intra-funnel and cross-funnel collisions, `/path-NNNN` suggestions, resolution subset validation, create-with-domain |
| Reorder | `steps.test.ts` | duplicate ids/orders, partial set, foreign ids, bad numbers, gap normalisation, link re-render |
| State machine | `funnels.test.ts`, `domains.test.ts` | live needs active domain, test detaches, domain loss/deletion revert in one transaction, rollback when the delete or the status update fails (a trigger injects the failure, written per dialect by `failOn`) |
| Versions | `pages.test.ts` | pruning at exactly 10/11, per step, autosave exempt, restore creates a backup, version conflicts, scripts policy |
| Funnels | `funnels.test.ts` | search/filters/sort/pagination, stats, duplicate naming, soft delete/restore/purge, tag case-insensitivity and scoping |
| Tenancy and roles | `tenancy.test.ts`, `auth.test.ts` | 404 for every resource type, no existence leak, role matrix, instant role changes |
| Public events | `public.test.ts` | unknown/deleted funnel, malformed, oversized (413), bots, duplicate idempotency, rate limit 429 + Retry-After |
| Forms and orders | `public.test.ts`, `exports.test.ts` | lead dedupe, honeypot, field validation, idempotent checkout, bump/upsell, decline, CSV injection |
| Analytics API: identity pepper | `pepper.test.ts` | importing a pepper (rules, fingerprint, audit), pepper endpoint auth (person or key scopes), DATA_ENCRYPTION_KEY, encryption of clear peppers, `PEPPER_UNREADABLE` recovery |
| Analytics API: rate limits | `ratelimit.analytics.test.ts` | separate read/export budgets, shared export bucket, Retry-After vs reset, no penalty box |
| Script entry points | `entrypoints.test.ts` | `npm run seed` in a child process |
| Analytics | `analytics.test.ts` | zero visits, rounding, inclusive range edges, time-zone and DST day boundaries, series |
| Webhooks | `webhooks.test.ts` | signature, backoff schedule, dead letter, SSRF table (v4/v6/mapped/NAT64/decimal/octal), DNS rebinding, redirects not followed |
| Preview and serving | `serving.test.ts` | token expiry/tamper/cross-funnel/cross-workspace, ETag/304, cookies and UTM sanitising, 301/home/404 rules, host matching |
| AI | `ai.test.ts` | invalid JSON, schema mismatch, empty, throws, refusal, truncation, prompt injection, fallback, invented numbers, rate limit and daily cap |
| DNS | `domains.test.ts` | pending/active/failed transitions, resolver errors, timeout, job polling with backoff |

## Web tests

112 tests in 8 files (Vitest, jsdom, Testing Library), 2026-10-20:

* `ui/tokens.test.ts` (64): parses `styles.css` and checks every text and background pair of the design tokens for WCAG AA (4.5:1) in the light set, the dark set and the `prefers-color-scheme` copy, that the two dark sets are identical, and the focus ring contrast.
* `builder/panels.test.tsx` (11): the builder panels on a **headless GrapesJS editor** (no iframe) inside the real providers: the drop rules, Layers (tree, selection, lock and unlock, empty state), Blocks (categories, search, the custom code block hidden unless permitted, click-to-insert following the drop rules), Inspector (empty state, tabs, a style change writes one rule on the element and one undo step), and a regression test for two quick edits of one product (the second must not overwrite the first with a stale copy; it fails if the fix is removed).
* `builder/headless.test.ts` (1): the editor boots headless, loads a project through `cleanProject` and registers the blocks.
* `components.test.tsx`, `pages/pages.test.ts`, `pages/orders.test.tsx`, `components/supportAccess.test.tsx`, `api/client.test.ts`: step reordering by keyboard with rollback, API error display, login validation, modal focus trap, toasts, reorder model and validators, order status and dispute badges, support banner.

## Not covered

Browsers other than Chromium (Firefox and WebKit), touch input (HTML5 drag events do not fire on touch screens), screen readers, real DNS, real Anthropic calls, concurrent multi-process access to the SQLite file, Redis, PostgreSQL versions other than 17 (CI) and 18 (PGlite and the local verification run), PostgreSQL behind a connection pooler such as pgbouncer in transaction mode (named prepared statements would need to be disabled there).

## Phase 2 additions

`server/test/phase2.test.ts` covers the edge signing contract (skew, replay, fail-closed), the edge endpoint, purge jobs and the Cloudflare adapters (mocked `fetch`), CF-Connecting-IP trust, the event buffer (batching, overflow, shutdown flush, read-your-writes), batched rollup maintenance (compared with a raw `GROUP BY` per local day in UTC, New York, Kolkata and Auckland), `EXPLAIN` index checks on every engine (PostgreSQL runs them with sequential scans disabled), an N+1 guard, gzip/metrics, 2,600-row streaming CSV, and `Promise.all` concurrency tests: same-version saves (one winner), parallel duplicates/reorders/domain attach, parallel identical submissions and exact rate limiting. `edge/test/edge.test.ts` tests the worker with fake Cache/KV, verifying each signed call with the origin's real verifier. These run in the normal `npm test` (892 server tests on SQLite, 22 edge tests, 112 web tests on 2026-10-20). Not covered: workerd/miniflare, Redis.

## Browser tests (Playwright)

`e2e/` drives real Chromium against the **built** server serving the **built** web app (`npm run build` first), with an in-memory SQLite database and a fake DNS resolver (`e2e/server.mjs`, so `*.e2e.test` domains can be verified; the browser maps that suffix to 127.0.0.1). Run: `npm run e2e:install` once (downloads Chromium, about 100 MB), then `npm run e2e` (35 tests, about 2 minutes on an Apple M1). One worker, no retries (a retry would hide flakiness); traces and screenshots are kept for failures (`npx playwright show-trace e2e/test-results/.../trace.zip`). CI job `e2e` runs it and uploads the report on failure.

**How the builder is driven.** Drags are real mouse input: `mouse.down`, `mouse.move` in steps, `mouse.up`, from a tile in the Blocks panel across into the canvas iframe, from the floating toolbar's move handle, and between rows of the Layers panel; handles are grabbed where they have come to rest (`settledBox`) because the canvas scrolls smoothly to a new block. The editor instance (`window.__editor`) is only read in assertions (component types, selection, rules), never used to perform an action.

`builder.spec.ts` (13):

| Test | What it proves |
|---|---|
| selecting in the canvas fills the inspector | no CSP violation, no page error, GrapesJS makes no outbound request (telemetry and CDN icon font are off) |
| a block dragged from the panel lands where it is dropped | live placeholder visible while dragging, one block added, undo and redo through the buttons |
| reorder with the toolbar move handle | canvas reorder and undo |
| nest a block into a column | drop on an empty column puts the block inside it |
| reorder sections by dragging in Layers | drag between layers |
| resize an image by its handle | the width is stored as a percentage |
| edit text in place, change a style, switch device, undo and redo, save, reload | double-click editing, Style tab (alignment) on this element, tablet 768 px and mobile canvas widths, undo and redo, persistence |
| copy, paste, duplicate, delete, shift-click | keyboard operations and multi-select |
| context menu and shortcuts dialog | open and close with Escape |
| unsafe input is refused or stays text; the published page equals the editor | a `javascript:` address blocks saving with the reason; markup typed into a headline is published as text; the signed preview has the editor's text, no `gjs-`, `data-gjs`, `contenteditable` or event-handler attribute, and no `javascript:` |
| a form and a checkout built in the editor | checkout dropped and priced in the Settings tab; on a live domain the visitor sees the server-stored name and price, submits the opt-in form, and the lead is in the Leads tab |
| Save keeps the replaced version; History lists, previews and restores it | version history |
| layout at 1024 and 700 px; preview hides the tools | the inspector is a drawer at tablet width and both panels at phone width; preview mode |

`builder-flows.spec.ts` (10): Pages panel (add, duplicate, delete, switch), page settings (title and accent reach the published HTML), image upload, a disguised SVG refused, picker, alt text suggestion, link dialog (applied as a plain anchor, `javascript:` refused), saved blocks (saved, dropped back with its text, forms refused), publish dialog, keyboard-only moves (Alt+Arrow, Shift+Up, `?`), the mobile notice, dragging a section down in Layers, and saving while still typing in the page.

Other specs: `smoke.spec.ts` (sign-in and out, template and step reorder, a live funnel on a verified domain with a visitor's form submit and the lead, analytics), `access.spec.ts` (5), `admin.spec.ts`, `analytics-api.spec.ts`, `billing.spec.ts` (an order from a sales funnel refunded in part, the audit log).

**Bugs this suite found in the builder** (each is fixed and has a test): moving an element down one place did nothing, dragging a section down in Layers landed one place early, two quick edits of one product or form overwrote each other, Ctrl+S while typing saved without the typed text, links could not be applied to selected text, the saved-blocks list did not refresh, previews made third-party requests for embedded players, and GrapesJS telemetry and an icon-font CDN request were on by default.

**Known test quirks.** The very first synthesised drag after the editor loads is ignored unless the pointer has crossed the canvas once (the second drag always works); the `dragBlock` helper moves over the canvas first, and it has not been seen by hand, so it is listed as a known issue rather than explained away. Playwright's own injected script is refused inside sandboxed preview frames and logged as "Blocked script execution in 'about:srcdoc'"; the console checks ignore that message. A page behind an open modal dialog is not editable (the search field loses typed text), which is correct: tests wait for the dialog to close.

`e2e/design-shots.mjs` is not a test: it generates the screenshots in `docs/design/` ([design/DESIGN.md](design/DESIGN.md)).

Not covered (yet): the AI assistant dialog beyond the alt-text button, webhooks UI, the new-funnel wizard in the browser, other browsers, accessibility audits beyond role-based selectors.

## Commerce tests (templates, catalog, payments, product analytics)

`server/test/templates.library.test.ts` (every built-in template: validity, render, contrast, slots, responsive; a sample through the API), `templates.test.ts` (API, filters, ETag, import and export, seeding and upgrade rules), `products.test.ts` (money, catalog API, permissions, tenancy, price immutability, archive, checkout from the catalog, quantities, currencies, backfill, Stripe sync and reconciliation against the fake, promotion codes, subscriptions), `payments.test.ts` (status states, settings, tax, wizard, template bindings), `productanalytics.test.ts` (math, currency separation, time zones and DST, conversion and take rates, customers, access, CSV, v1 API), `analyticssummary.test.ts` (NumberGuard, narrator property test, endpoint, fallbacks, injection, quota). `fakestripe.ts` models products, prices, tax settings, promotion discounts, tax and subscription sessions.

## Stripe tests

`server/test/stripe.test.ts` (29 tests, all engines) runs against `server/test/support/fakestripe.ts`: signature scheme (rotation, replay), Connect onboarding and webhooks, hosted checkout parameters and fee by plan, webhook and return-URL race creating orders once, amount mismatch retry, Stripe outage, upsell success/decline/authentication/idempotency, refunds (partial, concurrent, Stripe failure, permissions, dashboard reconciliation), subscriptions and plan limits. A fake cannot prove Stripe's real behaviour: see the checklist in [STRIPE.md](STRIPE.md).

`server/test/disputes.test.ts` (17 tests, all engines, same fake): created, updated, closed won and lost, partial loss, duplicate delivery (same and different event id), out-of-order delivery (closed before created, stale updates), funds withdrawn/reinstated, orphans (known and unknown account, reconciled when the order appears, loss applied once), refund plus dispute in both orders, analytics math (funnel analytics, series, Analytics API v1), permissions and tenant isolation (another workspace, spoofed account). The shared Stripe test world lives in `server/test/support/stripeworld.ts`. Web: `web/src/pages/orders.test.tsx` (status badges, evidence due date, Stripe link).

## Admin tests

`server/test/admin.test.ts` (20 tests, all engines): every platform route refuses anonymous callers and ordinary owners (generated from the route declaration), administrator bootstrap and removal rules, mandatory 2FA (and the production forcing in `loadConfig`), workspace search and paging, suspension across every surface (serving, sessions, API keys, public writes, previews, edge purge job, reversal, other workspaces unaffected), impersonation (expiry on the fake clock, forbidden routes, audit in the workspace's log, no admin targets; read-only by default: GET/HEAD allowed, POST/PUT/PATCH/DELETE refused with `IMPERSONATION_READ_ONLY` and nothing changed; writes only with the flag plus the superadmin role plus a 20-character reason, each audited; the shorter write lifetime and its expiry; banner state in `/me`; a support-role administrator cannot enable writes or grant superadmin; the customer's audit log labels support access). Web: `web/src/components/supportAccess.test.tsx` (banner modes, dialog rules), flags (overrides, stable monotone rollout over 400 sample workspaces), queue inspector, GDPR export and erasure (books still add up, no address left in scrubbed tables or audit), workspace export (2300 rows across pages), deletion guard rails and cascade, announcements, platform audit.

## AI builder and Google reviews tests

`server/test/ai.builder.test.ts` (pipeline over the API: stages, determinism, permissions, concurrency, cancel, tenants, draft products and price range, regenerate step, scripted model: tokens and model recorded, untrusted wrapping, repair, malformed, refusal, timeout, outage, empty and banned-claim output degrading to the built-in writer, output budget, PII redaction, daily cap), `ai.edit.test.ts` (operation schema, plan problems, spec to component cleaning, `/api/ai/edit` and `/section` offline, with a model, repaired, rejected and failing), `ai.evals.test.ts` (24 golden briefs x built-in writer and four scripted model behaviours, 140 tests), `googlereviews.test.ts` (fake Places API; see [REVIEWS.md](REVIEWS.md)). Web: `AiBuilder.test.tsx`, `builder/aiEdit.test.ts` (one undo step on a headless GrapesJS editor), `builder/AiPanel.test.tsx`, `builder/reviews.test.tsx`, `pages/settings/IdentityPepper.test.tsx`. e2e: `tests/ai-reviews.spec.ts` and the pepper import step in `analytics-api.spec.ts`. Nothing reaches a model or Google.

## Ads and publishing tests

None of these touch a network: ad networks are answered by `server/test/support/fakenet.ts` (a scripted `fetch`), Cloudflare Pages by `server/test/support/fakecf.ts` (the documented endpoints, plus the behaviour a client can trip on: an asset must be uploaded before a deployment names it, a wrongly hashed file is accepted but never served, project and domain name rules, domains that stay pending or fail, a token without write permission, injected 429/5xx). **They prove the code against the documented shapes, not against Cloudflare, Meta, Google or TikTok.**

| File (tests per engine) | Covered |
|---|---|
| `ads.pixels.test.ts` (54) | strict id formats and XSS payloads as ids, settings merge workspace < funnel < step with `null` switch-off, JSON escaping of hostile product names and consent text, the pixel runtime executed in jsdom: consent gating (opt-in, opt-out, region rule, Do Not Track, stored choice, Consent Mode v2 signals, queued events, banner text as text), golden mapping of PageView, ViewContent, Lead, InitiateCheckout, AddPaymentInfo and Purchase for every network, one event id sent once, preview never loads a vendor script |
| `ads.hash.test.ts` (37), `ads.providers.test.ts` (17) | SHA-256 vectors, email (dots, plus tags, gmail rules per network), phone E.164 table, unicode names, ZIP, country; golden request JSON for Meta, GA4 and TikTok (Purchase and Lead), token placement, no raw identifier, response classification (retry or permanent), secret redaction |
| `ads.touch.test.ts` (19) | sanitising UTMs and click ids (control, zero-width and bidi characters, lengths, hostile text), inference from click ids and referrers, first/last touch merge including late and out-of-order touches and every arrival order, browser id shapes |
| `ads.integrations.test.ts` (18) | encrypted and masked tokens, audit without secrets, validation, permissions and tenant isolation, test events per network, a lead and an order becoming hashed deliveries with the shared event id, idempotency, retries with backoff, dead letters and manual re-send, permanent refusals, disabled integrations, one Purchase per checkout, tenant separation |
| `ads.attribution.test.ts` (10) | the public attribution endpoint (bots, previews, unknown and foreign funnels, malformed and oversized bodies), stamping of leads and orders, consent gating of server-side conversions with and without a banner |
| `ads.spend.test.ts` (33), `ads.report.test.ts` (16) | CSV reader (BOM, CRLF, quotes, embedded newlines, delimiters, broken quoting with line numbers), money parsing, import (dry run, skip invalid, duplicates, idempotent re-import, missing columns, 20,000 rows, oversized), formula neutralisation on export, ROAS math (zero spend, zero revenue, refunds, first versus last touch, aliases, mapping, hints), currencies never mixed and yen as whole units, time-zone day boundaries, grouping, permissions and tenancy |
| `ads.pixels.api.test.ts` (7), `ads.contract.test.ts` (5) | pixels in stored and previewed pages, refusal of malformed ids, overrides, workspace defaults; the v1 ads and attribution endpoints validated against the JSON Schema files |
| `publish.bundle.test.ts` (47) | asset hash vectors, paths (decoded traversal, unicode, collisions, case), determinism and order independence, partial changes, home and 404 rules, image copying and rewriting, limits, 300 and 1,000 page funnels, paused bundle, per-page CSP (strict, relaxed for owner code), upload batching |
| `publish.service.test.ts` (42) | connection (read-call verification, masked storage, wrong token and account, read-only token, re-verify, disconnect), target choice (project creation, adoption, names, platform account and plan limit), the deployment state machine (build, upload only what changed, no-op, debounce, single flight and last wins, restart in the middle, images), failures (stage failure and redeploy, outage retries, `Retry-After`, permission, timeout, size, deleted project, shared domain, secrets redacted), rollback with hold, unpublish (pause, delete, adopted projects), automatic pause and resume, suspension, purge, custom domain states, CNAME verification, CORS for Pages origins |
| `public.test.ts`, `serving.test.ts` | CORS allow-list and `open` mode; the beacon's attribution report and its consent handling |

Web: `web/src/pages/growth/growth.test.tsx` (8: id formats, form body building, connection and project name checks, CSV file checks, import problems rendered as text, number formatting).

Browser: `e2e/tests/growth.spec.ts` (3): connect Cloudflare (fake) with a wrong then a right token, publish a funnel, follow the history, roll back, unpublish; Meta pixel and consent on a signed preview (banner, nothing fires before Accept, then the events); import ad spend from CSV (one bad row reported, valid rows imported) and see ROAS and the unmatched campaign. The e2e server now runs the job worker and answers Cloudflare from the fake. `e2e/growth-shots.mjs` regenerates the screenshots of these screens. Known: `smoke.spec.ts` tests that use `createLeadMagnet` fail since the template gallery opens a wizard and has two "Lead magnet" templates (not part of this area).
