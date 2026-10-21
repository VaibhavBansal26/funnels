# Glossary

| Term | Meaning |
|---|---|
| Product / price | A catalog entry a checkout sells and one way to pay for it (amount in minor units, currency, optional billing interval and trial). Prices are immutable: a new amount is a new price and the old one is archived. Replaces the price typed into a checkout block. |
| Product slot | A placeholder in a template ("main", "bump", ...) bound to a catalog product when the template is used. |
| Net revenue | `gross - refunded`, where `gross` already excludes amounts lost to lost disputes. |
| Workspace | The tenant. Owns users, funnels, domains, tags, leads, orders, webhooks. Every business row has `workspace_id`; a resource of another workspace is a 404. |
| Funnel | An ordered set of steps published as a unit. Has a status (`test` or `live`), optional domain, tags, soft delete (trash). |
| Step | One page of a funnel with a path (`base_path`, compared through `path_key`), a position, a `version`. |
| Page / document | `step_pages.doc_json` is the source of truth: `{ version: 2, project, forms, products }`. `html` is the server's sanitised render, with a `checksum` (also the ETag). |
| Project | The GrapesJS project data of a page: a tree of components plus CSS rules. The editable source of truth; the browser sends nothing else when saving. |
| Block | A tile in the builder's Blocks panel that inserts one or more components (Hero, Heading, Checkout, ...). Also the old *block document* element (version 1), which only exists as an input to the converter (`server/src/blocks`). |
| Component | One node of a project: a section, row, column, text, image, form, ... Dynamic ones (`fn-form`, `fn-checkout`, ...) carry typed props. |
| Converter | `pagemodel/convert.ts`: block document (version 1) to project (version 2), deterministic. |
| Derived lists | `forms` and `products` in the stored document, computed by the server from the typed props on every save; what the public endpoints trust. |
| Domain | A customer hostname with DNS verification (`pending`, `active`, `failed`) that funnels can be attached to. |
| Live / test | A live funnel is served on its address (built-in, Cloudflare Pages or Workers, or an active custom domain) and its visits, leads and orders are recorded. A test funnel is only visible through a signed preview and nothing is counted. Payment test mode is a different thing: it follows the Stripe key (`sk_test_`) or the built-in test provider. |
| Path key | Lower-cased path without trailing slash; the unit of path uniqueness inside a funnel and on a domain. |
| Version | `steps.version`, bumped on every save; the optimistic-concurrency token. |
| Backup | Previous page documents kept per step (newest 10, autosaves excluded). |
| Event | A row in `events`: `page_view`, `optin` or `order`. Browsers can only report the first two. |
| Rollup | `event_rollups`: counts per funnel, step and 15-minute UTC bucket, written with every event batch. Analytics read these. |
| Event buffer | Write-behind queue in front of `events` (flush every `EVENT_BUFFER_MS` or `EVENT_BUFFER_MAX` rows). |
| Unique visit | First `page_view` of a visitor on a step; decided by the server. Funnel-level unique = distinct visitors. |
| Lead | A person by email per workspace; later submissions update the same lead. |
| Order | A purchase recorded by the server-side checkout; bumps and one-click upsells are separate order rows linked by `parent_order_id`. |
| Job | A row in `jobs` run by the in-process worker: webhook and conversion deliveries, domain verification, edge purge, Cloudflare deployments (`publish.*`), AI builds, review refreshes, maintenance ([FUNCTIONS.md](FUNCTIONS.md#background-jobs)). Claimed fairly per workspace, with `FOR UPDATE SKIP LOCKED` on PostgreSQL. |
| Edge / Worker | The optional Cloudflare Worker in front of the origin (cache, stale-while-revalidate, signed resolve, edge rate limiting). |
| Purge | Telling Cloudflare to drop cached URLs after a change. |
| Policy | One entry of the rate limit registry (`ratelimit/policies.ts`): key, algorithm, limit, window, burst, failure mode. |
| GCRA | Generic cell rate algorithm; the token-bucket equivalent that stores one timestamp per key. |
| Subject | The key a policy counts against: `ip:...` (readable) or a hash of a user, workspace, visitor or composite. |
| Lease (rate limit) | Tokens pre-paid from Redis and spent locally. Not the concurrency lease. |
| Penalty box | Temporary block with escalating duration (1 min to 24 h) after repeated refusals. |
| Plan / tier | `free`, `pro`, `business`: multiplier on workspace quotas. |
| Dialect | The named SQL differences between SQLite and PostgreSQL (`db/dialect.ts`). |
| Scoped deps | The `Deps` copy handed to code inside `inTx`, whose `db` is the transaction. |
| Platform admin | A row in `platform_admins` (bootstrapped from `PLATFORM_ADMIN_EMAILS` or added in Admin > Administrators), role `support` or `superadmin`; not a workspace role. |

## Publishing and ads

| Term | Meaning |
|---|---|
| Publish target | Where a funnel is served from: this server (`origin`), Cloudflare Pages (`cloudflare-pages`) or the experimental Cloudflare Workers static assets (`cloudflare-workers-assets`) |
| Address | Where a live funnel is reached: the built-in address, a Cloudflare Pages or Workers address, or a verified custom domain. Chosen in Go live. |
| Built-in address | `<APP_PUBLIC_URL>/s/<workspace slug>/<funnel slug>/<step path>`: free, on the app's own host, no DNS ([GO-LIVE.md](GO-LIVE.md)) |
| System domain | A `domains` row of kind `builtin` or `pages` with a synthetic `.invalid` hostname: never matched by a Host header, not shown on the Domains page, not counted against plan limits |
| Slug | The URL-safe name of a workspace or funnel in a built-in address; stable when the name changes, editable |
| Go live | Choosing an address and setting the funnel live in one step (`POST /api/funnels/{id}/go-live`); Take offline returns it to test |
| Publish state | What Go live shows: Test mode, Publishing..., Live, Publishing failed, Paused |
| Bundle, version id | The static site built from a funnel, and the 12-hex hash of its files, headers and redirects (shown like a commit id) |
| Hold | After a rollback or an unpublish, automatic deployments wait until someone presses Redeploy |
| Pixel | A network's browser tag (Meta Pixel, Google tag, TikTok Pixel, LinkedIn Insight, Microsoft UET), generated from its id |
| Conversions API | A network's server-to-server event endpoint (Meta CAPI, GA4 Measurement Protocol, TikTok Events API) |
| Event id | The id shared by a browser pixel event and its server-side twin so the network keeps one (`lead_<submission>`, `purchase_<order>`) |
| First touch, last touch | The earliest and the latest (non-direct) marketing touch of a visitor, lead or order |
| ROAS | Return on ad spend: revenue / spend, in one currency |

## Legacy to new

| Legacy product | This app |
|---|---|
| Collections (`funnels`, `lightning.domains`, `funnels.analytics`) | Tables (see [MIGRATION-NOTES.md](MIGRATION-NOTES.md)) |
| GrapesJS components / `raw_html` | GrapesJS project data; the server renders and sanitises the HTML (see [MIGRATION-NOTES.md](MIGRATION-NOTES.md#page-builder-the-grapesjs-rebuild-adr-0022)) |
| `getrollbackversion` / backups | Backups and restore |
| Cloudflare "hosts" | Domains with a `DomainProvider` |
| Global funnel templates | `templates` + `template_steps`, platform-admin managed |
| `lightning` worker route | Host routing in the origin plus the optional Worker |
| Analytics "views / unique" documents | Typed events + rollups |


## AI and reviews

| Term | Meaning |
|---|---|
| Generation | One run of the AI funnel builder, stored in `ai_generations` with prompt, assumptions, stages, token use and report |
| Edit operation | One validated change the builder assistant proposes (insert, replace, delete, move, setText, restyle) |
| Block token | Public HMAC handle (`rv...`) of a Google reviews block, used by `GET /public/reviews/{token}` |
| Assumption | Something the AI funnel builder decided because the description did not say it; listed on the result page |
| Draft product | A catalog product created by the AI builder; not synced to Stripe until you sync it |

## Accounts, payments and platform

| Term | Meaning |
|---|---|
| Role / permission | A role is a named set of permissions (`funnels:write`, `orders:refund`, ...); four built-in roles plus custom roles per workspace ([RBAC.md](RBAC.md)) |
| Session, refresh token | A sign-in on one device; the refresh token rotates on every use and a reused one revokes the session |
| Recovery code | One of 10 single-use codes shown when two-factor authentication is turned on |
| Connected account | The workspace owner's own Stripe account, linked with Stripe Connect Standard; checkouts are charged on it |
| Application fee | The share of each checkout Funnels keeps through Stripe Connect: Free 5 %, Pro 2 %, Business 0 |
| Built-in test provider | `PAYMENTS_PROVIDER=mock`: orders are recorded as if paid, no card is charged |
| Order bump, one-click upsell, downsell | An add-on ticked on the checkout; an offer after the purchase charged to the same card without re-entering it; the offer shown to those who decline the upsell |
| Dispute, charge back | A Stripe dispute on a payment; `charged_back` is the order status after a lost dispute |
| Plan limit | A cap on funnels, domains, members, API keys or hosted Pages projects per plan, enforced only with `BILLING_ENFORCE_LIMITS` |
| API key | A workspace key (`fa_live_` / `fa_test_`) for the analytics API v1, with scopes, optional expiry and IP allow-list |
| Identity pepper, contact key, visitor key | The per-workspace secret and the HMAC-SHA256 keys computed with it that identify people in exports without personal data ([ANALYTICS-API.md](ANALYTICS-API.md)) |
| Fingerprint | First 8 hex characters of the SHA-256 of the pepper, to compare two apps without revealing it |
| Suspension | An administrator stops a workspace: sessions end, pages and public writes stop, API keys are refused |
| Support access | A time-limited session in which a platform administrator acts as a workspace owner; read-only unless a superadmin enables writes; recorded in the workspace's audit log |
| Feature flag | A switch evaluated per workspace (override, rollout percentage, default), such as `ai_assistant` |
| Announcement | A banner an administrator shows to every signed-in user |

