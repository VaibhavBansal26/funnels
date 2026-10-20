# Analytics API v1

A read-only HTTP API for pulling Funnels analytics into other systems (the Python `intelligence` service, a warehouse, a spreadsheet): totals per funnel and step, time series, and raw exports. It implements the shared analytics contract; responses are described by JSON Schemas in [analytics-api/](analytics-api/) (generated from the code, validated against live responses by the contract tests). Code: `server/src/routes/analyticsapi.ts`, `server/src/services/analyticsapi.ts`, `server/src/services/apikeys.ts`, `server/src/analyticsapi/schemas.ts`. Decision record: [ADR 0019](adr/0019-analytics-api.md).

## Authentication

Workspace **API keys**: `Authorization: Bearer fa_live_<random>` (or `fa_test_<random>`).

* Created by a person with `api_keys:manage` (Settings, API access, or `POST /api/v1/api-keys`); **the secret is shown once**, only its SHA-256 is stored, the list shows a prefix and when the key was last used.
* **Scopes:** `analytics:read` (funnels, steps, time series, schema) and `analytics:export` (the three exports). A user can only create keys with scopes they hold themselves (`analytics:read`, `analytics:export` are also permissions).
* **Optional expiry** and **IP allow-list** (addresses and CIDR ranges, IPv4 and IPv6; the client address is resolved with the same trusted-proxy rules as everywhere else, see [RATE-LIMITING.md](RATE-LIMITING.md#client-address)). **Revocable** at any time; every create, change and revoke is audited.
* **Mode:** a `live` key sees the workspace's `live` funnels, a `test` key its `test` funnels (the same split as the rest of the app; test funnels only collect data through previews, so test keys are for wiring up an integration). Trashed funnels are invisible to both.
* Unknown, malformed, expired and revoked keys all answer the same `401`; a valid key without the scope, or from a disallowed address, is `403`. A user session token is not an API key and an API key does not open the app API (`/api/...` other than `/api/v1/analytics`).
* Every response is scoped to the key's workspace; another workspace's funnel is a `404`.

```
curl -s https://app.example.com/api/v1/analytics/funnels?from=2026-03-01&to=2026-03-31 -H "authorization: Bearer $FA_KEY"
```

## Conventions

* Base path `/api/v1/analytics`. JSON; timestamps are UTC ISO-8601; ids are opaque strings.
* `from`, `to`: a date (`2026-03-01`: the whole local day in `tz`, `to` inclusive) or a datetime **with an offset** (`2026-03-01T00:00:00Z`; `to` exclusive). Default: the last 30 local days, today included. At most 366 days. `tz`: IANA zone, default `UTC`, used only to decide where days, weeks and months start. Aggregates are read from 15-minute buckets, so a datetime range is widened to 15-minute edges; exports use the exact instants.
* Lists: `?limit=` (up to 1,000, default 100) and `?cursor=` → `{ "data": [...], "next_cursor": string | null }`. Cursors are opaque.
* Errors: `{ "error": { "code", "message" } }`, plus `details` on validation errors and `retry_after_s`, `policy` on `429`. Objects in responses are open: **ignore fields you do not know** (additive changes only within v1).
* Extra fields, additive within v1: none beyond the contract here (`phone_key` and `dow_created` exist only in Conversations' room export, where `dow_created` is JavaScript's `getDay()`: Sunday = 0). Funnels' funnel-structure export keys funnels by `id` and steps by `step_id` and carries no step `type`.
* **Rates are fractions between 0 and 1** (not percentages), rounded to 4 decimals. Money is in major currency units (`47.5`), rounded to 2 decimals.

## Endpoints

| Method and path | Scope | Returns |
|---|---|---|
| `GET /funnels` | read | `[{ id, name, status, steps_count, visits, unique_visits, optins, optin_rate, orders, gross, currency, earnings_per_view, created_at }]` |
| `GET /funnels/{id}/steps` | read | per step `{ step_id, name, order, visits, unique_visits, optins, optin_rate, orders, gross, exit_rate, avg_time_on_page_s }` |
| `GET /funnels/{id}/timeseries?metric=&interval=` | read | `{ interval, metric, tz, points: [{ t, value }] }`, zero-filled |
| `GET /schema` | read | `{ schema_version, schemas: { ... JSON Schemas ... } }` |
| `GET /export/events` | export | NDJSON, one event per line |
| `GET /export/leads` | export | NDJSON, one lead per line |
| `GET /export/funnel-structure` | export | funnels with steps: block counts, word counts, order bump, upsell |

### Definitions (where the contract leaves room, this is what the numbers mean)

* `visits`: page views, summed over all steps of the funnel in the range.
* `unique_visits` (funnel): visitors whose first-ever view of the **entry step** (position 1) fell in the range. (The dashboard's funnel total counts distinct visitors over all steps instead; the two differ on purpose, see [ADR 0019](adr/0019-analytics-api.md).) For a step: visitors whose first view of that step fell in the range.
* `optin_rate` = `optins / unique_visits`; `earnings_per_view` = `gross / visits`; both `0` when the denominator is `0`.
* `exit_rate` (step *i*): of the visitors who first saw step *i* in the range, the share who never saw step *i+1*, at any time. `null` for the last step.
* `avg_time_on_page_s`: always `null`; time on page is not collected.
* `currency`: the single currency of the funnel's orders in the range; `null` when there are none or they are mixed (gross then sums amounts in different currencies, so treat it with care).
* **Time series.** Metrics: `visits`, `unique_visits` (entry-step first views, so the points add up to the funnel's `unique_visits`), `optins`, `orders`, `gross`. Intervals: `hour` (range at most 31 days), `day`, `week` (ISO, starting Monday), `month`; `t` is the start of the interval as a UTC instant, following the local calendar of `tz` (so New York days start at 04:00Z or 05:00Z depending on DST). Intervals with no data are present with `0`. In the repeated hour at the end of daylight saving time the two local hours are merged into one point.

### Exports and the PII policy

Exports never contain raw email, phone, name or visitor id. Contacts and visitors are identified by keys:

* `contact_key` = hex `HMAC-SHA256(workspace_pepper, lower(trim(email)))`
* `visitor_key` = hex `HMAC-SHA256(workspace_pepper, "v:" + visitor_id)`

The **workspace pepper** is a per-workspace secret. A person holding `analytics_identity:manage` **and** `analytics:export` can view, set and rotate it (Settings, API access shows and rotates it; `GET|PUT /api/v1/analytics/identity-pepper`, `POST .../rotate`); an API key carrying both scopes can **read** it (never change it). Copy it into the other system and it computes the same `contact_key` for the same email, so two apps owned by one customer can be joined without exchanging any personal data: see [Sharing the pepper between apps](#sharing-the-pepper-between-apps). Rotating or setting it changes every key (consumers must adopt the new pepper and re-key; the action is audited). Free text (form answers, product copy) is never exported; leads carry only the derived fields below.

### Sharing the pepper between apps

Every workspace starts with its own random pepper, so two apps of one customer produce different keys for the same e-mail address until both use the same value. `GET /api/v1/analytics/identity-pepper` answers `{ pepper, version, algorithm: "HMAC-SHA256", fingerprint, rotatedAt }` (the same shape in Funnels and Conversations; schema `identity-pepper.schema.json`). To join two apps:

1. Pick one value: `openssl rand -hex 32` (or read the pepper of the other app).
2. Set it: `curl -X PUT -H "Authorization: Bearer $SESSION_TOKEN" -H "Content-Type: application/json" -d '{"pepper":"<value>","confirm":"<value>"}' .../api/v1/analytics/identity-pepper`. `confirm` is optional; when sent it must repeat the pepper exactly (`400 PEPPER_CONFIRM_MISMATCH`). A person's session is required (an API key can read, not change).
3. Compare `fingerprint` (first 8 hex characters of SHA-256 over the pepper) in both apps: equal fingerprints mean equal peppers, and the fingerprint reveals nothing usable.

Rules (`400 INVALID_PEPPER` otherwise): 32 to 256 printable ASCII characters without spaces; a hex pepper needs 64 characters and a base64 pepper 43 (32 bytes); at least 12 distinct characters, about 128 bits of entropy by a Shannon estimate, no repeated pattern or sequence. The value is used exactly as typed (nothing is trimmed), so both apps must get the same string. Setting the stored value again changes nothing; a different value adds 1 to `version`, sets `rotatedAt` and writes an `analytics.pepper_set` audit entry holding the fingerprint, never the pepper (rotate writes `analytics.pepper_rotated`).

An API key with `analytics:export` + `analytics_identity:manage` can read the pepper, which lets a leaked integration key recompute contact keys from e-mail addresses: give the scope only to the service that needs it. Such a key counts against `analytics.read` and `analytics.workspace`.

The settings page shows and rotates the pepper but has no form for importing one yet; the API above is the supported way (UI follow-up).

**Stored encrypted.** `workspaces.identity_pepper` holds `enc2.<keyId>.<ciphertext>`: AES-256-GCM under a key derived from `DATA_ENCRYPTION_KEY`, bound to the workspace id (earlier versions stored it in clear). In production `DATA_ENCRYPTION_KEY` is required once the pepper is used: without it the pepper routes and the exports answer `503 DATA_ENCRYPTION_KEY_REQUIRED`; development derives a key from `JWT_SECRET` and warns at start-up. A value in clear is encrypted the first time it is read (the value, `version` and `rotatedAt` do not change); to rotate the data key put the old value in `DATA_ENCRYPTION_KEY_PREVIOUS` ([RUNBOOK.md](RUNBOOK.md)). A pepper that cannot be decrypted is `409 PEPPER_UNREADABLE`, never a `500`; `PUT` or `POST .../rotate` replaces it and recovers.

**Events** (`type`: `page_view`, `optin`, `order`): `id, ts, type, funnel_id, step_id, visitor_key, contact_key, utm_source, utm_medium, utm_campaign, device, country, referrer_host, amount, currency, unique_visit`.

* `device` (`desktop`, `mobile`, `tablet`, `unknown`) comes from the User-Agent at ingestion, `referrer_host` from `document.referrer` (host only, never the URL), `country` from Cloudflare's `CF-IPCountry` **only when the request provably came through our Cloudflare zone** (otherwise `null`: anyone can send that header). Events recorded before this API existed, and server-created ones (orders), have `device: "unknown"` and `null` country and referrer.
* `contact_key` is set for events tied to a lead (opt-ins, orders), `null` for anonymous page views. `amount` and `currency` only on orders.

**Leads:** `id, created_at, funnel_id, step_id, contact_key, source, utm_source, utm_campaign, converted_to_order, order_total, first_order_at`. `source` is `form` or `checkout` (how the lead first arrived); `step_id` and the UTMs come from the lead's earliest event.

**Paging, resuming and compression.** An export request returns up to `limit` lines (default 5,000, **at most 20,000**: above that is `400`; the contract's 1,000 is the minimum every app must accept) ordered by `(ts, id)` and, when more exist, the response header `X-Next-Cursor`; pass it as `?cursor=` for the next page. The order is stable and a cursor can be reused after a failure (resumable: no row is skipped or repeated, even when new events arrive). `X-Row-Count` tells how many lines this page has. Send `Accept-Encoding: gzip` for compressed pages (bodies under 1 KB are sent plain).

```
cursor=""
while :; do
  curl -sD h.txt -H "authorization: Bearer $FA_KEY" -H 'accept-encoding: gzip' --compressed \
    "https://app.example.com/api/v1/analytics/export/events?from=2026-03-01&to=2026-04-01&limit=20000${cursor:+&cursor=$cursor}" >> events.ndjson
  cursor=$(grep -i '^x-next-cursor:' h.txt | cut -d' ' -f2 | tr -d '\r'); [ -z "$cursor" ] && break
done
```

**Funnel structure** (`/export/funnel-structure`, JSON): per funnel `steps[] { step_id, name, order, path, blocks { form, checkout, video, countdown }, word_count, has_order_bump, has_upsell }` plus funnel-level `has_order_bump`, `has_upsell`, `word_count`. Word count covers visible copy: headings, paragraphs, button labels, list items and FAQ questions and answers.

## Rate limits

Per API key: `analytics.read` 60 requests per minute (`ANALYTICS_API_PER_MINUTE`), `analytics.export` 10 per minute (`ANALYTICS_EXPORT_PER_MINUTE`); and per workspace across all its keys: `analytics.workspace` (a plan-tiered quota, so many keys cannot multiply the load). Refusals are `429` with `Retry-After`, the IETF `RateLimit` headers and the usual body; see [RATE-LIMITING.md](RATE-LIMITING.md).

## Push: `analytics.daily_rollup_ready`

Subscribe a webhook (Settings, Webhooks) to the event `analytics.daily_rollup_ready` to learn when a UTC day is complete. The maintenance job announces **yesterday** once per workspace and day (a marker table makes it exactly once across replicas): `{ id, event, createdAt, data: { day, from, to, tz: "UTC", funnels: [ids that had data], schemaVersion: 1 } }`. Deliveries carry `X-Signature: sha256=<hex HMAC-SHA-256 of the body with the webhook secret>` (and the existing `X-Funnels-Signature` over `timestamp.body`), are retried like every webhook, and are idempotent by the payload `id`. The announcement is a nudge, not a guarantee: after an outage days are skipped, and a consumer should be able to poll any range.

## Versioning

Additive changes only within v1 (new fields, new endpoints); `schema_version` in `GET /schema` changes only with a new major version. The schema files in [analytics-api/](analytics-api/) are the machine-readable contract: `funnels`, `steps`, `timeseries`, `export-event`, `export-lead`, `funnel-structure`, `error`.

## Measured: export memory is bounded

`node --expose-gc bench/export.mjs <events>` seeds events (in-memory SQLite, Apple M1 under load, Node 24, 2026-10-20) and pages the whole export at `limit=20000` following `X-Next-Cursor`:

| Events | Pages | Rows/s | Median page | Largest page | RSS growth during the export |
|---|---|---|---|---|---|
| 300,000 | 15 | 153,000 | 132 ms | 8.5 MB | 153 MB |
| 1,200,000 | 60 | 107,000 | 175 ms | 8.5 MB | 81 MB |

Quadrupling the data did not grow memory (growth is allocator and GC noise around one page, not proportional to rows), and the page size is capped by `limit`. This is SQLite in memory with no network: PostgreSQL adds a round trip per page and the read of the partitioned table; not measured.

## Limits and what is not covered

* Exports of the whole history are many requests (20,000 lines each, 10 per minute per key by default): about 200,000 lines per minute per key; raise `ANALYTICS_EXPORT_PER_MINUTE` for a backfill or use the database mirror ([SCALING.md](SCALING.md)).
* Workspace-wide event exports page on `events (workspace_id, created_at, id)`; on a very large PostgreSQL table the migration that adds this index locks writes while it builds: run it in a maintenance window.
* `unique_visits` at funnel level undercounts visitors who enter a funnel at a later step.
* No webhook for hourly data, no cohort or retention endpoints, no write access. `avg_time_on_page_s` is `null` until time on page is collected.
