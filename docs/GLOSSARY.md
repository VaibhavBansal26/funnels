# Glossary

| Term | Meaning |
|---|---|
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
| Live / test | A live funnel is served on its active domain. A test funnel is only visible through a signed preview. |
| Path key | Lower-cased path without trailing slash; the unit of path uniqueness inside a funnel and on a domain. |
| Version | `steps.version`, bumped on every save; the optimistic-concurrency token. |
| Backup | Previous page documents kept per step (newest 10, autosaves excluded). |
| Event | A row in `events`: `page_view`, `optin` or `order`. Browsers can only report the first two. |
| Rollup | `event_rollups`: counts per funnel, step and 15-minute UTC bucket, written with every event batch. Analytics read these. |
| Event buffer | Write-behind queue in front of `events` (flush every `EVENT_BUFFER_MS` or `EVENT_BUFFER_MAX` rows). |
| Unique visit | First `page_view` of a visitor on a step; decided by the server. Funnel-level unique = distinct visitors. |
| Lead | A person by email per workspace; later submissions update the same lead. |
| Order | A purchase recorded by the server-side checkout; bumps and one-click upsells are separate order rows linked by `parent_order_id`. |
| Job | A row in `jobs`: webhook delivery, domain verification, edge purge. Claimed with `FOR UPDATE SKIP LOCKED` on PostgreSQL. |
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
| Platform admin | An account listed in `PLATFORM_ADMIN_EMAILS`; not a workspace role. |

## Publishing and ads

| Term | Meaning |
|---|---|
| Publish target | Where a funnel is served from: this server (`origin`) or Cloudflare Pages |
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
