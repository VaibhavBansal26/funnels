# Error monitoring (Sentry)

Optional and **off unless you configure it**. With no `SENTRY_DSN` the server never imports the Sentry SDK and nothing is sent; the web app asks `GET /api/config`, sees no DSN and downloads no Sentry code. Decision record: [ADR 0046](adr/0046-sentry-error-monitoring.md). **Status: verified with a fake transport only; no real Sentry project was used to build this** (see "Not verified").

## Set it up (about five minutes)

1. In Sentry create a project (platform **Node.js**; one project can receive both server and browser errors, or create a second one of platform **React** for the browser). Copy its **DSN** from *Settings > Projects > (project) > Client Keys (DSN)*. A DSN is not an auth token and this app needs no Sentry auth token.
2. On Render: your service > **Environment** > add `SENTRY_DSN` with the value (and optionally `SENTRY_WEB_DSN` for a separate browser project, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`). Save: Render redeploys. Locally put it in your shell, never in a committed file.
3. **Release tagging.** Render sets `RENDER_GIT_COMMIT` itself; the app uses it as the Sentry release (`SENTRY_RELEASE` overrides it; for Docker builds elsewhere pass `--build-arg GIT_SHA=$(git rev-parse HEAD)`). The release is also served to the browser, so server and browser errors group under the same commit.
4. **Verify.** Sign in as a platform administrator > **Admin > Monitoring** > **Send test error**. The result shows the event id; the event "Funnels test error: sent by a platform administrator at ..." appears in Sentry within a few seconds. The same page shows the environment, release, sample rate and Sentry host (never the DSN).
5. **Alerts to configure in Sentry** (Alerts > Create alert): (a) *Issue alert*: "a new issue is created" in `environment:production` -> email or Slack; (b) *Issue alert*: an issue is seen more than 10 times in 10 minutes (a crash loop, see below: the app already limits repeats to 5 per minute per error); (c) *Issue alert*: tag `kind:job` (a job failed for good: webhooks, conversions, deployments), notify the owner; (d) *Metric alert* on the failure rate of transactions if you enabled tracing; (e) a *regression* alert on resolved issues. The tags `request_id`, `route`, `workspace` and `plan` are filterable.

## What is sent, and what is never sent

Everything passes `server/src/monitoring/scrub.ts`, an **allow-list**: the event is rebuilt from known-safe fields, so anything not listed is dropped, including fields a future SDK version adds. The browser uses the same file (shared source). Tests: `server/test/monitoring.test.ts`, `web/src/monitoring/monitoring.test.tsx`.

| Sent | Detail |
|---|---|
| Error type and message | message scrubbed: emails, JWTs, Bearer tokens, Stripe / Google / Anthropic keys, `password=`/`token=` pairs, URL query strings, IP addresses and any 32+ character token are replaced; cut to 300 characters |
| Stack | file names reduced to `src/...`, `node_modules/...` or `assets/...`; function, line, column; **no source lines, no local variables** |
| Tags | `request_id`, `route` (the route **pattern**, `/api/funnels/:id/steps`, never the URL), `workspace` (a **hash** of the workspace id: first 12 hex characters of sha256 of `workspace:<id>`; Admin > Workspaces shows it as `monitoringId`), `plan`, `kind` (`request`, `job`, `test`), `job_type` |
| Context | trace ids, runtime name and version, SDK name and version, release, environment, HTTP method |
| Transactions (only if `SENTRY_TRACES_SAMPLE_RATE` > 0) | route pattern, timing, status; span names and data are dropped |

Never sent: request bodies, form submissions, cookies, `Authorization` and any other header, query strings, emails, names, passwords, API keys, Stripe / Cloudflare / Google keys, page content and builder documents, uploaded files, the user's IP address, user ids, breadcrumbs, `extra` data, local variables, device or OS details, the server host name. `sendDefaultPii` is `false`, and because @sentry/node 11 replaced that flag by `dataCollection` every category there is switched off too (`userInfo`, `cookies`, `httpHeaders`, `httpBodies`, `urlQueryParams`, `stackFrameVariables`, `databaseQueryData`, ...). Breadcrumbs are disabled. **The job payload is never part of a report.**

What is reported: unhandled errors, `5xx` responses (including a `5xx` `AppError` such as a payment provider failing, and a request timeout), and jobs that failed for good (attempts exhausted). Ignored on purpose: every `4xx`, validation errors, rate limits (`RATE_LIMITED`), load shedding (`INGEST_BACKPRESSURE`), aborted requests and connection resets. **Noise control:** at most 5 events per minute per error fingerprint (type, message without numbers, top application frame) and 60 per minute overall; the admin test event bypasses it. Uncaught exceptions and unhandled promise rejections are captured by the SDK and still end the process, as without Sentry. On `SIGTERM` the app flushes pending events (up to 2 s) before exiting.

**Browser.** `@sentry/react`, loaded by a dynamic import into its own chunk (`sentryLoader-*.js`, about 30 KB gzip, outside the first-load budget; it has its own budget in `web/scripts/check-bundle-size.mjs`). It captures render errors (the new error boundary and the router's `errorElement` show a plain fallback and report) and unhandled errors and rejections, only from this app's own `/assets/` scripts (`allowUrls`): the builder canvas and published pages run other people's scripts, and their errors are not sent. No session replay (not installed), no performance tracing, no breadcrumbs, no user identity: only the hashed workspace tag.

## How the browser gets its settings

The browser DSN is runtime configuration, not a build constant, so one image works everywhere: the web app calls `GET /api/config` (public, cacheable 5 minutes) at start and receives `{"monitoring": {dsn, environment, release, tracesSampleRate}}` or `{"monitoring": null}`. The DSN comes from `SENTRY_WEB_DSN`, else `SENTRY_DSN`. A browser DSN is visible to anyone who opens the app, by design: it can only send events (set an allowed-domains filter in the Sentry project's client key settings).

## Source maps (out of scope)

The web build does not publish source maps (`sourcemap: false`) and the app never uses a Sentry auth token. To get readable browser stacks, add it in your own CI with your own token, never in this repository: build with `sourcemap: 'hidden'`, then `npx @sentry/cli sourcemaps inject web/dist && npx @sentry/cli sourcemaps upload --release=$GIT_SHA web/dist` with `SENTRY_AUTH_TOKEN` as a CI secret, and do not deploy the `.map` files. The server runs compiled JavaScript with the file names kept (`dist/...`): its stacks are readable without maps.

## Operating notes

* Cost and quota: errors are rate limited as above; tracing defaults to 5 % of requests. Set `SENTRY_TRACES_SAMPLE_RATE=0` to turn tracing off.
* A DSN that is not valid is logged once at start (`SENTRY_DSN is not a valid DSN`) and monitoring stays off; the app starts normally.
* If Sentry is unreachable, capturing fails silently; monitoring can never fail a request.

## Not verified

No real Sentry project was used: the tests run the real `@sentry/node` 11.8.0 SDK against a fake transport that records the envelopes, and the browser tests use a fake SDK module. Unverified: delivery to Sentry's ingest, how Sentry groups these scrubbed events, that the DSN host check in Admin matches your region's host, `traceLifecycle: 'static'` transactions in the Sentry UI, and the browser SDK in a real browser. After setting `SENTRY_DSN`, press *Send test error* and look at the event: that is the check.
