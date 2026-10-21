# 0046. Optional Sentry error monitoring with an allow-list scrubber

Status: Accepted (verified with a fake transport only)

## Context

Errors on a free-plan Render deployment were visible only in logs. Operators want alerts on unhandled errors, 5xx responses and dead jobs. Error reporters are also the classic way to leak personal data (request bodies, headers, emails inside exception messages), and this app handles leads, orders, page content and API keys.

## Decision

* **Off unless configured**: `SENTRY_DSN` unset means the SDK is never imported (`createMonitor` returns an inert object), so there is no network access and no overhead. An invalid DSN disables monitoring with a warning and never stops the app.
* **Allow-list, not deny-list** (`monitoring/scrub.ts`): `beforeSend` rebuilds the event from known-safe fields; unknown fields are dropped by default. Free text goes through a scrubber. The same file is compiled into the web app (shared source, like the page model), so one policy covers both.
* **Identity**: only a hash of the workspace id (`sha256("workspace:<id>")`, 12 hex characters) and the plan. No user id, email, IP.
* **What counts**: unhandled errors, 5xx (including `AppError` 5xx and request timeouts) and jobs that failed for good, from the places that already know (`app.onError`, the request middleware, the job worker). Expected failures are ignored by rule, and a per-fingerprint limit (5 per minute) and a global one (60 per minute) bound the volume.
* **SDK configuration**: @sentry/node 11 replaced `sendDefaultPii` by `dataCollection`; both are set to off. Breadcrumbs are off. `traceLifecycle: 'static'` so that `beforeSendTransaction` (our scrubber) applies; transactions are created by the request middleware with the route pattern as name. Unhandled rejections stay fatal (`mode: 'strict'`), matching Node's default without Sentry.
* **Browser**: runtime configuration from `GET /api/config`, `@sentry/react` imported lazily through one loader module (its own chunk and budget), error boundaries plus router `errorElement`, only errors from this app's own scripts (`allowUrls`), no replay, no tracing, no breadcrumbs.
* **Verification path**: Admin > Monitoring shows the status (never the DSN) and sends a labelled test event.
* No Sentry auth token anywhere; source map upload is documented for the operator's own CI.

## Alternatives considered

A deny-list of sensitive keys (a new field leaks by default); relying on Sentry's server-side data scrubbing (the data has already left); OpenTelemetry auto-instrumentation (needs ESM loader flags and records URLs and SQL); a build-time browser DSN (one image per environment); Sentry session replay (records page content: ruled out); wrapping every service in try/catch to report (the central handlers already see everything).

## Consequences

A scrubbed message can be less useful than the raw one; the request id lets the operator find the full context in the logs. The scrubber must be kept in step with new secret formats (the long-token rule is the safety net). The server SDK adds about 55 MB to `node_modules` (including its bundled tooling packages) and roughly 590 lines to the lockfile; the browser SDK adds about 30 KB gzip to the lazy chunk.
