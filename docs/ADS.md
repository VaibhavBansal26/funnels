# Ads: pixels, server-side conversions, attribution, spend and ROAS

What this covers, what it does not, and how the pieces fit. Decision records: [ADR 0031](adr/0031-ads-conversions-attribution.md). Security view (consent, hashing, tokens): [SECURITY.md](SECURITY.md#ads-consent-hashing-and-tokens).

## What this is not

**The app does not create or manage campaigns in Meta, Google, TikTok, LinkedIn or Microsoft.** That needs each platform's app review and per-customer OAuth, which this repository does not have. Spend is therefore **entered by hand or imported from the CSV export** of the ad manager; impressions and clicks are optional. What the app does do: put the networks' tags on your pages (from IDs only), send the networks the conversions the server itself verified, remember where every visitor came from, and join your spend to your results.

**Verification status.** The Meta Conversions API, GA4 Measurement Protocol and TikTok Events API requests are built from the documented shapes and tested against fakes (golden JSON, retries, dead letters). They have **not** been sent to the real networks. The TikTok payload comes from secondary descriptions (the official reference page is a client-rendered portal that could not be read as text). Use *Send test event* (below) with each network's own test tool before trusting a number. Browser pixels are loaded from the vendors' public script URLs; the loader snippets are written from memory of the vendors' standard snippets, not copied, and were never executed against the real libraries (the tests replace them with stubs).

## Pixels and tags (browser)

Settings per **workspace** (default), **funnel** and **step**; a step overrides its funnel, which overrides the workspace, per network (`null` switches a network off for that level). `GET|PUT /api/pixels`, `/api/funnels/{id}/pixels`, `/api/funnels/{id}/steps/{sid}/pixels`; permission `integrations:manage` to change, `funnels:read` to read; every change is audited and the affected pages are re-rendered.

| Network | You enter | Strict format |
|---|---|---|
| Meta Pixel | Pixel ID | 8 to 20 digits |
| Google tag | GA4 measurement ID; Google Ads conversion ID, purchase label, lead label | `G-` + 6 to 12 capitals/digits; `AW-` + 6 to 12 digits; labels `[A-Za-z0-9_-]{6,40}` |
| TikTok Pixel | Pixel code | 10 to 30 capitals/digits |
| LinkedIn Insight | Partner ID; conversion IDs for purchase and lead | digits |
| Microsoft UET | Tag ID | 6 to 12 digits |

**The server generates the snippet from these IDs; you never paste script text here.** A value that does not match its format is refused on save (400) and left out again at render time. The configuration is serialised as JSON with `<`, `>`, `&` and U+2028/9 escaped, so even a hostile product name cannot close the script element. The one arbitrary-script path remains the owner-only custom code, exactly as before.

**Automatic events** (names per network in the table): `PageView` on load, `ViewContent` on a step with a checkout (the main product), `Lead` (opt-in per scope: *Events > Lead*), `InitiateCheckout` on first focus inside a checkout form, `AddPaymentInfo` on submit, `Purchase` with value, currency, content ids and names from the page's product catalog.

| Event | Meta | GA4 | TikTok | LinkedIn / Microsoft |
|---|---|---|---|---|
| PageView | `PageView` | `page_view` | `page()` | automatic |
| ViewContent | `ViewContent` | `view_item` | `ViewContent` | - |
| Lead | `Lead` | `generate_lead` (+ Ads conversion `send_to`) | `SubmitForm` | conversion id / `lead` |
| InitiateCheckout | `InitiateCheckout` | `begin_checkout` | `InitiateCheckout` | - |
| AddPaymentInfo | `AddPaymentInfo` | `add_payment_info` | `AddPaymentInfo` | - |
| Purchase | `Purchase` | `purchase` (+ Ads conversion) | `CompletePayment` | conversion id / `purchase` |

**Deduplication.** The beacon reports `Lead` with the event id `lead_<submissionId>` and `Purchase` with `purchase_<first order id>`; the server's own Conversions API event uses the *same* id, so Meta and TikTok keep one of the two. Hosted Stripe checkout redirects away, so the browser does not know the order id there: only the server `Purchase` is sent (documented limitation, nothing to deduplicate).

**Preview.** In the builder preview the runtime never loads a vendor script. It records what it *would* send in `window.__fnAdsLog` and shows it in a small panel top right, so you can see the events fire without polluting your pixels.

## Consent

Per scope (usually the workspace default): *Cookie consent* on/off, mode `opt_in` (nothing loads until *Accept*) or `opt_out` (loads at once, the banner offers *Decline*), region `everyone` or `eu_uk` (only visitors whose browser time zone is in Europe wait and see the banner; an unknown time zone counts as Europe; this is a heuristic, not geolocation), texts, policy link, position, **Respect Do Not Track / Global Privacy Control** (default on: nothing loads, no banner, and the server will not send that visitor's conversions).

* The choice is stored in the first-party cookie `fn_consent` (180 days). A link with `data-fn-consent-settings` reopens the banner.
* **Google Consent Mode v2**: when a Google tag is configured and consent is required, `dataLayer`/`gtag` are defined and `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization` are set to `denied` (with `wait_for_update: 500`) before anything else, and updated to `granted` on *Accept*. With consent required, the vendor libraries themselves also wait for consent (stricter than Google's own "load denied, ping cookieless" mode).
* Events that happen before a choice are queued and sent on *Accept*, dropped on *Decline*.
* The banner text is set with `textContent`; it cannot carry markup.
* **Server side:** the beacon reports the visitor's consent state with the attribution record. Server-side conversions respect it: with a banner in use only `granted` sends; without one, only an explicit `denied` (Do Not Track, a decline) blocks. Blocked conversions appear in the delivery log as `skipped`.
* Click ids (`gclid`, `fbclid`, ...), `_fbp`/`_fbc`/`_ttp`/`_ga` are sent to the attribution endpoint only when consent is not `denied`/`unknown`. UTM parameters (campaign names, not personal data) are always recorded.

## Server-side conversions

`ConversionsProvider` interface, three implementations, one queue. Integrations are per workspace: `GET|POST /api/integrations`, `PATCH|DELETE /api/integrations/{id}`, `POST /api/integrations/{id}/test`, `GET /api/integrations/{id}/deliveries`, `POST /api/integrations/deliveries/{id}/retry`; permission `integrations:manage` (not held by members and viewers).

| Provider | Endpoint (config) | Auth | Test |
|---|---|---|---|
| Meta Conversions API | `POST {META_GRAPH_BASE}/{META_GRAPH_VERSION}/{pixel_id}/events` | access token in the JSON body (never the URL) | `test_event_code` from Events Manager (required to send a test) |
| GA4 Measurement Protocol | `POST {GA4_MP_BASE}/mp/collect?measurement_id=&api_secret=` (EU: `region1.google-analytics.com`) | API secret (query string: GA4 offers no alternative; never logged) | `/debug/mp/collect` returns `validationMessages` |
| TikTok Events API | `POST {TIKTOK_EVENTS_BASE}/open_api/v1.3/event/track/` | `Access-Token` header | `test_event_code` |

**What is sent and when.** Only events the server itself witnessed: `Lead` when an opt-in form is accepted (after validation, inside the same transaction that stores the lead) and `Purchase` when an order is persisted. Orders are persisted only after the payment is confirmed (the mock provider's charge, or Stripe reporting the Checkout Session paid, whichever of webhook and return gets there first; both verify with Stripe before writing), so the Stripe-verified order is the source of truth, not the browser. One `Purchase` per checkout (the main offer and its bumps share it; value is the total; items list each line); an upsell is its own purchase. The deliveries are rows written in that transaction, so they exist if and only if the lead or order does.

**Identifiers.** Email, phone (E.164), first and last name, ZIP, country, city, state and the visitor id (as `external_id`) are normalised per network and hashed with SHA-256 (tables below); IP address, user agent, `fbp`, `fbc`, `ttp`, `ttclid` are sent as the networks require (unhashed). Phone numbers need a `+`/`00` prefix to be sent (the app does not guess a country code). The delivery log stores the *request without its token, with hashed identifiers*; it never holds a raw email or phone.

| Value | Meta | Google (GA4) | TikTok |
|---|---|---|---|
| email | trim, lower-case | + remove dots in the local part for gmail.com / googlemail.com | trim, lower-case |
| phone | digits with country code, no `+` | `+E.164` | `+E.164` |
| names | lower-case letters only (any script), no punctuation or spaces | same | not sent |
| ZIP | lower-case, no spaces or dashes; US: first 5 digits | in clear in the address block | not sent |
| country | lower-case ISO alpha-2, hashed | upper-case, in clear | not sent |

**Delivery.** Queue `conversion.deliver` (per-workspace fair claims). Success: `sent`. A temporary failure (timeout, 5xx, 429, Meta rate-limit codes, TikTok codes >= 50000) is retried with exponential backoff (30 s, 60 s, ... capped at 1 h) up to `CONVERSIONS_MAX_ATTEMPTS` (6); then `dead`. A permanent refusal (bad token, invalid parameter) is `dead` at once, with the network's message. Dead and failed deliveries can be re-sent from the screen. Dedupe: unique `(integration, event name, event id)`; the same submission or order never produces two deliveries. Events older than 7 days are refused by Meta (documented), so do not retry after a week.

**Tokens** are encrypted at rest with `DATA_ENCRYPTION_KEY` (AES-256-GCM, key id in the ciphertext, bound to the integration), returned masked (`••••` + last four characters), never logged, and absent from audit entries and error texts (a redaction test feeds a token through every path). In production the integration cannot be created without `DATA_ENCRYPTION_KEY` (503). Every create, change, delete and test is audited.

## Attribution

The beacon posts to `POST /api/public/attribution` once per page load that carries a new touch (UTM parameters, a click id or an external referrer) or when the visitor first appears and again after a consent choice. The server stores per visitor a **first touch** (the earliest touch with marketing information) and a **last touch** (the latest; a direct visit never replaces either: last *non-direct*), with `utm_source/medium/campaign/content/term`, click ids (`gclid`, `fbclid`, `ttclid`, `msclkid`, `li_fat_id`), referrer host, landing path, `fbp`, `fbc`, GA client and session ids.

* Source and medium are lower-cased; a click id without UTMs infers a source (`gclid` -> google/cpc, `fbclid` -> facebook/paid_social, `ttclid` -> tiktok, `msclkid` -> bing/cpc, `li_fat_id` -> linkedin), an external referrer without UTMs becomes `referrer-host / referral`. Inferred touches are marked.
* All values are sanitised: control, zero-width and bidirectional characters removed, whitespace collapsed, 100 characters (click ids: `[A-Za-z0-9_.-=*~:]{4,200}`); anything else is dropped. Hostile text is stored as inert data and escaped by every renderer.
* A late-arriving older touch may become the first touch but never replaces the last.
* A lead is stamped with both touches when created (its first touch is written once, the last touch is replaced as a whole by each later submission); an order is stamped once at purchase and history is never rewritten.
* The IP address and user agent kept for server-side conversions expire after `ATTRIBUTION_RETENTION_DAYS` (90) without a visit.

## Ad spend and ROAS

`GET|POST /api/ads/spend`, `DELETE /api/ads/spend/{id}`, `POST /api/ads/spend/import`, `GET|PUT /api/ads/mappings`, `DELETE /api/ads/mappings/{id}`, `GET /api/ads/performance`, `GET /api/ads/attribution` (+ `/export` CSV); `ads:read` / `ads:write` (members and viewers read; admins and owners write).

**A row** is one day, source (platform, e.g. `facebook`), optional account, campaign name and **currency**, with the amount in minor units of that currency (yen are whole units) and optional impressions and clicks. The same day, source, account, campaign and currency replaces the earlier amount. A day is a calendar date as the ad platform reported it (its account time zone); it is compared as written.

**CSV import** (`Content-Type: text/csv`, at most `ADS_IMPORT_MAX_ROWS` (20,000) rows and 2 MB):

| Column (case-insensitive; synonyms accepted) | Notes |
|---|---|
| `date` / `day` | `YYYY-MM-DD` (a trailing time is ignored) |
| `source` / `platform` | or `?source=` for the whole file |
| `account` | optional |
| `campaign` / `campaign name` | |
| `currency` | ISO 4217, or `?currency=` |
| `spend` / `cost` / `amount spent` | `1234.50`, `1,234.50`, `$1,234.50`; negative and `1.234,50` are refused |
| `impressions`, `clicks` | optional whole numbers |

Handles a byte-order mark, CRLF/LF, quoted fields with commas, line breaks and doubled quotes, `;` or tab separators. Every row is validated and every problem is reported with its line and column; by default **one bad row refuses the file** (`422 IMPORT_INVALID`, nothing written); `skipInvalid=true` imports the valid rows; `dryRun=true` only reports; duplicate rows inside one file are an error unless `duplicates=sum`. Importing the same file again updates rather than duplicates.

**Joining spend to results.** A spend row matches traffic by *(platform, campaign)*: the platform of the spend source and of the traffic's `utm_source` after folding common aliases (`facebook`, `fb`, `instagram`, `ig`, `meta` -> `meta`; `google`, `adwords`, `youtube` -> `google`; ...), and the campaign name (or its mapped `utm_campaign`) compared case-insensitively. Spend whose campaign never shows up in the traffic is listed as **unmatched** with a suggestion (same letters, different punctuation); *Map* stores `(source, campaign) -> utm_campaign [+ utm_source]`. Results of campaigns with no spend recorded are reported separately as `other`, so ROAS only compares spend with the traffic it bought.

**Definitions** (per report, in one currency): `revenue` = orders' amounts minus refunds and minus amounts lost in Stripe disputes; `orders` = checkouts (a bump rides with its main offer); `CPL = spend / leads`; `CPA = spend / orders`; `CPC = spend / clicks`; `CTR = clicks / impressions`; `ROAS = revenue / spend`; `profit = revenue - spend`. A ratio with a zero denominator is `null`, never infinity or a made-up number. **Currencies are never added together**: the report takes `currency` (default: the one with the most money in the range); the others are listed in `currencies`.

**Date range and time zone.** `from`/`to` are inclusive local dates in `tz` (default UTC, at most 366 days). Revenue is bucketed to local days of `tz`; spend days are calendar dates. Use the time zone of your ad account for the cleanest comparison. `model=first|last` picks the touch; `groupBy=campaign|source|funnel|day`.

**Direct visits.** The attribution report adds a `(direct)` row: distinct page-view visitors in the range with no recorded marketing touch. This reads raw events (time-bounded) rather than rollups; on a very large range it is the slowest part of the report.

## API v1 (additive)

`GET /api/v1/analytics/ads` and `GET /api/v1/analytics/attribution` with an API key carrying `analytics:read`, following [ANALYTICS-API.md](ANALYTICS-API.md): snake_case, `{ data, next_cursor: null, ... }`, whole calendar days, `group_by`, `model`, `currency`, `funnel_id`. Test-mode keys see test funnels only, which have no spend. JSON Schemas: [ads](analytics-api/ads.schema.json), [attribution](analytics-api/attribution.schema.json); contract tests validate live responses against the files.

## Operating it

* **Send a test event** after connecting: Meta and TikTok need the test code from the network's Events Manager; the event then shows in its *Test events* tab. GA4: the validation endpoint reports problems in the response.
* A red *last status* on an integration means the most recent delivery failed; open the log for the network's message.
* Pages are re-rendered when pixels change; the edge cache is purged for live funnels.
* Rate limits: `integrations.test` 10/min, `ads.import` 12/h, reads and writes use the usual `api.*` policies ([RATE-LIMITING.md](RATE-LIMITING.md)).
* Permissions: `integrations:manage`, `ads:read`, `ads:write` ([RBAC.md](RBAC.md)).

## Known limits

* Meta Graph API version defaults to `v23.0` (`META_GRAPH_VERSION`); versions are retired after about two years, so check yearly.
* GA4's Measurement Protocol cannot carry a `gclid`; ad attribution of its events relies on the GA4-to-Google-Ads link. Google Ads *enhanced conversions for leads* and the Google Ads API (offline conversions) are not implemented.
* No LinkedIn or Microsoft server-side conversions (their browser tags are supported).
* The consent region rule is a time-zone heuristic.
* Safari limits cookies set by JavaScript to 7 days; the server-side record does not depend on them, but `_fbp`/`_ga` values read in the browser inherit that.
