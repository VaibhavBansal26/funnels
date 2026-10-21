# 0030. Publish targets: serving from this server or from Cloudflare Pages

Status: Accepted (unverified against real Cloudflare: see [CLOUDFLARE-PAGES.md](../CLOUDFLARE-PAGES.md))

## Context

Live funnels were served by the origin by Host header, optionally behind a caching Worker. Customers want pages that survive an origin outage and absorb traffic spikes without the app's involvement, and some already use Cloudflare. Cloudflare Pages Direct Upload accepts a prebuilt static site through an API.

## Decision

* A funnel has a **publish target** (`origin` default, `cloudflare-pages`), stored in `funnel_publish`; the origin keeps working unchanged. Pages is chosen per funnel.
* The static site is built from the same rendered, sanitised HTML the origin serves, in a **pure, deterministic bundle builder** (`publish/bundle.ts`): same input, same bytes, same manifest, same 12-hex version id. That makes "nothing changed" detectable, builds testable without a network, and the history readable like commits. Dynamic parts are not reimplemented: the page keeps calling the public API at an absolute `API_PUBLIC_URL`, with CORS allow-listed per funnel domain.
* Deployment is **queued, persisted, idempotent and single-flight per funnel** (a lease row; one queued row per funnel; the build reads the database when it runs, so the last change wins). Polling is its own job, so a slow Cloudflare never blocks the worker, and a restart in the middle is finished by the next worker. Failures are classified (retry with backoff and `Retry-After`; fail fast on permission errors; build errors never reach the network).
* Credentials: a per-workspace Cloudflare account id and API token (scope "Cloudflare Pages: Edit"), encrypted with the existing `DATA_ENCRYPTION_KEY` mechanism, masked everywhere, audited; optionally a platform account (`CF_PAGES_*`) for hosted installations with one `fn-<id>` project per funnel and plan limits.
* The Cloudflare API is wrapped in `CloudflarePagesClient` over an injectable `fetch`; tests use `FakeCloudflarePages`, which reproduces the documented shapes and behaves like the real service where a client can trip (hash must be uploaded before a deployment names it; a wrongly hashed file is accepted and never served). Everything is labelled unverified, and `scripts/cf-pages-smoke.ts` is the means to verify it.
* **Rollback holds**: Cloudflare's rollback moves its production alias but our data does not move, so a rollback sets a hold that stops automatic deployments until *Redeploy*; otherwise the next autosave would silently undo it.
* Safety rules: never overwrite a project the app did not create without explicit confirmation; never delete one it did not create; one funnel per domain on Pages; paths validated after percent-decoding.

## Alternatives considered

Serving static files from this app's own bucket/CDN (no new moving part, but it is a CDN we would have to build); Workers with KV or R2 (more power, much more surface: per-visitor logic is not needed); shelling out to Wrangler (a Node CLI in the server image, opaque failures, tokens on argv/env of a child process); letting the browser build and upload (the browser must never hold a Cloudflare token); blocking in the job until a deployment finishes (simple, but one slow deployment stalls every other job); a global deployment mutex (would serialise tenants: fairness is per funnel).

## Consequences

A change reaches visitors in seconds to minutes rather than immediately; two sources of truth for what is live (our database, Cloudflare) are reconciled by the history and the no-op check; operators must understand Cloudflare tokens, DNS and deployment failures (RUNBOOK). The CSP of published pages is exact for the platform's own scripts and necessarily relaxed for owner-authored code. The asset hash algorithm is taken from Wrangler's source, not from the REST reference: if Cloudflare changes it, files upload but are not served until the code follows (the smoke test catches that).
