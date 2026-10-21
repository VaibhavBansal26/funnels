# Verified vs not verified against real services

Everything in this repository is covered by automated tests, but every third-party service is replaced by a fake in those tests (an in-memory Cloudflare, Stripe, Google Places, LLM, Sentry transport, DNS resolver, mailer and HTTP client). A passing suite therefore proves our code against **our reading of each service's documentation**, not against the service. This page says, honestly and per integration, what has been run against the real thing.

Last reviewed 2026-10-21, against the code at that date. Update it whenever something is run against a real account.

| Integration | Real run? | What was checked | What is not checked | How to check it yourself |
|---|---|---|---|---|
| **Cloudflare Pages: go live on `*.pages.dev`** | **Yes, by the maintainer, on a real account** | Connecting an account and going live on the free Pages address. The first real run failed (Cloudflare rejected `per_page=100` when counting projects, code 8000024); fixed in commit 1438c8c (see [CHANGELOG](../CHANGELOG.md)). | No automated real run is in the repository; this documentation pass did not repeat it. | `server/scripts/cf-pages-smoke.ts` ([CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md#6-prove-it-with-the-smoke-script-recommended-once)) |
| Cloudflare Pages: rollback, unpublish (pause or delete), custom domain on a project, the 100-project and new-account limits, the platform-account mode (`CF_PAGES_*`) | No recorded run | Fake (`server/test/support/fakecf.ts`) following the documented API shapes | Real error codes and wording for the limits (matched by text), real propagation latency | the same smoke script covers deploy, rollback and delete |
| Cloudflare Workers static assets (experimental target) | No | Fake only | Everything real | `server/scripts/cf-workers-smoke.ts` |
| Edge worker (`edge/`), Cloudflare for SaaS domains, cache purge | No (in this pass) | Unit tests with fake Cache, KV and fetch; signed calls verified with the origin's real code | A deployed worker, real purge, real custom hostnames | deploy with the `deploy-edge` workflow ([CLOUDFLARE.md](CLOUDFLARE.md)) |
| **Stripe** (Connect onboarding, hosted Checkout, finalization, one-click upsell, refunds, disputes, platform subscriptions, catalog sync) | **Sandbox shape checks only; never a real charge** | In-process fake (`server/test/support/fakestripe.ts`) and an e2e fake Stripe; request and response field names checked against Stripe's API reference and sandbox response shapes | A real test-mode payment end to end, webhook delivery from Stripe, application fees on a real connected account, 3-D Secure, disputes with real evidence | the test-mode checklist at the end of [STRIPE.md](STRIPE.md#test-mode-validation-checklist-not-yet-done) |
| Meta Conversions API, GA4 Measurement Protocol, TikTok Events API | No | Golden JSON against fakes; TikTok from secondary descriptions of the API | Acceptance by the networks, deduplication with the browser pixel, match quality | *Send test event* in Ads > Integrations with each network's test tool ([ADS.md](ADS.md)) |
| Browser pixels (Meta, Google, TikTok, LinkedIn, Microsoft) and the consent runtime | No | Generated snippets unit-tested; CSP host lists | That each vendor's loader still works as written | open a live page with the vendor's pixel helper extension |
| Google Places API (New) for reviews | No | Fake (`server/test/googlereviews.test.ts`) | Real responses, quota behaviour, terms | Settings > Google reviews > Test fetch with your own key ([REVIEWS.md](REVIEWS.md)) |
| Anthropic model (AI funnel builder, builder assistant, rewrite, insights, summary) | No | Built-in writer plus a scripted fake model (good, bad, malformed, failing) in 24 golden evals | Real output quality, latency, cost, refusals | `server/scripts/ai-smoke.ts` with your own `ANTHROPIC_API_KEY` ([AI-BUILDER.md](AI-BUILDER.md)) |
| Sentry | No | The real `@sentry/node` SDK against a fake transport | Delivery to a real project, grouping, the browser SDK against Sentry | Admin > Monitoring > Send test error ([MONITORING.md](MONITORING.md)) |
| ClickHouse secondary store | No | Fake HTTP server answering from the primary database | The SQL itself on ClickHouse | [ADR 0016](adr/0016-clickhouse-secondary-store.md) |
| DNS verification of custom domains | No real domain in tests | Injected resolver (the e2e suite answers for `*.e2e.test`) | Real resolvers, propagation | add a real domain and press Verify |
| Mail (`MAIL_TRANSPORT=webhook`) | No | Capturing mailer in e2e | Your mail relay | point `MAIL_WEBHOOK_URL` at your relay |
| Render free deployment (`render.yaml`) | Not by this pass | Blueprint file and `deploy-check` workflow | Whether the blueprint still matches Render's current product | [DEPLOY.md](DEPLOY.md) |

## What is verified for real in this repository

* The application itself: the server suite runs against **SQLite, in-process PostgreSQL (PGlite, PostgreSQL 18 in WASM) and a real PostgreSQL server** (the CI job uses `postgres:17`), and the rate limiter and event bus suites run against **real Redis** ([TESTING.md](TESTING.md)).
* The web app and the builder in a **real browser** (Playwright, real mouse drags) against the built server ([TESTING.md](TESTING.md)).
* For this documentation pass (2026-10-21): the app was built, seeded (`npm run seed`) and run locally on a random port; every page in [USER-GUIDE.md](USER-GUIDE.md) was opened in Chromium and its text and controls compared with the guide; going live on the built-in address, taking it offline, moving a funnel to the trash and restoring it were exercised over the HTTP API (headers checked: `X-Robots-Tag`, cookie path, CSP, 404 after taking offline, restore in test mode).

## Where the interface said "not exercised"

The Settings > Publishing card and the comment in `server/src/services/publishing.ts` now say that going live on pages.dev was run on a real account and that custom domains and the Workers address were not. Comments in `server/src/publish/*.ts` still describe the adapters as never run against real Cloudflare, which stays true for the parts the real run did not reach.
