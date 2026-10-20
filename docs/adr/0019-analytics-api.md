# 0019. Analytics API v1: API keys, HMAC identity keys, definitions

Status: Accepted

## Context

The Python `intelligence` service (and customers' own tools) need analytics without a user session: totals, time series and raw events, in a stable machine-readable form, without personal data leaving the app. The shared contract fixes the endpoints, key format, scopes, NDJSON export with keyset paging, and the PII policy (HMAC keys with a per-workspace pepper), and leaves several definitions open.

## Decision

* **Keys:** `fa_live_` / `fa_test_` random secrets, SHA-256 at rest, shown once, scopes, expiry, IP allow-list (reusing the trusted-client-IP logic), revocation, last-used, audit; created only by people with `api_keys:manage` and never with more scopes than they hold. Key routes are a separate auth class (`apikey`) in the route declaration, with the scope next to the route and the same central tests (missing key 401, other scope 403, limiter layers present).
* **Mode** splits visibility by funnel status (live keys see live funnels, test keys test funnels), mirroring how the product already separates real and preview traffic.
* **Identity keys:** `contact_key = HMAC-SHA256(pepper, lower(trim(email)))`, `visitor_key = HMAC-SHA256(pepper, "v:" + visitor_id)`. The pepper is a per-workspace secret created lazily, viewable and rotatable only by a person (never by a key) holding `analytics_identity:manage` and `analytics:export`; rotation is audited.
* **Definitions:** rates are fractions in [0,1]; funnel `unique_visits` is the entry step's first views, so a time series adds up to the list value and can be computed from the 15-minute rollups without scanning events; `exit_rate` uses the exact first-view ledger; `avg_time_on_page_s` is `null` (not collected); `currency` is `null` for none or mixed.
* **Ingestion additions:** `device` (User-Agent), `referrer_host` (host of `document.referrer`) and `country` (`CF-IPCountry`, believed only for requests proven to come through our Cloudflare zone, or forwarded in the signed edge batch) are stored on events; a migration adds the columns and an index on `(workspace_id, created_at, id)` for workspace-wide exports.
* **Exports** are pages, not streams: fetch `limit + 1` rows ordered by `(created_at, id)`, answer `limit` lines and put the cursor in `X-Next-Cursor`, so the header is known before the body, memory is bounded, and a cursor resumes exactly. gzip is done in the route (the global compressor does not know NDJSON).
* **Contract artifacts:** response shapes are zod schemas, emitted as JSON Schema files (`docs/analytics-api/`), served at `/schema`, and validated against live responses with a JSON Schema validator in tests. Objects are open for additive evolution.
* **Push:** `analytics.daily_rollup_ready` rides on the existing webhooks, announced once per workspace and day through a marker table, with the contract's body-only `X-Signature` added next to the existing timestamped signature.

## Alternatives considered

OAuth client credentials (a token endpoint and refresh logic for a machine client that a long-lived scoped key serves; keys are what the contract specifies); unsalted hashes of emails (trivially reversible by anyone with a list of emails: the pepper is what makes the keys safe to hand out); distinct-visitor counts per funnel and interval from raw events (exact but a scan per request; the rollup-based entry-step definition is cheap and additive); streaming the whole export (needs the cursor before the end of the body, and holds a connection and a database cursor open); sums of per-step unique counts as funnel uniques (double counts visitors who see several steps).

## Consequences

The funnel-level `unique_visits` here is not the dashboard's distinct-visitor number; both are documented. Events recorded before the migration have no device, country or referrer. Rotating the pepper breaks joins until consumers update. A PostgreSQL migration adds an index on the partitioned `events` table (a blocking build on a large table). Cloudflare is the only source of country, so deployments without it export `null`. A `test` key sees almost no data by design.
