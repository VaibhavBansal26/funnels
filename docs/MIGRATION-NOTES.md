# Migration notes

## Collections to tables

| Legacy | New |
|---|---|
| `funnels` (`global:true` templates mixed in) | `funnels`; templates are `templates` + `template_steps` |
| `funnel.step` (`raw_html`, `settings`, thumbnails) | `steps` (settings as columns) + `step_pages` (`doc_json`, cached `html`, `checksum`) |
| `funnel.step.components` | `step_pages.doc_json` (block document, not GrapesJS) |
| `funnel.step.backups` | `step_backups`, pruned on save |
| `funnel.tags` | `tags` + `funnel_tags` (`name_lower` unique per workspace) |
| `funnel.blocks` / `funnel.global.blocks` | `custom_blocks` (per workspace); global blocks dropped |
| `funnel.global.templates.categories` | `template_categories` |
| `lightning.domains` (+ unused `funnels.domains`) | `domains` |
| `funnels.analytics` | `events` (typed) + `orders`; opt-in people in `leads` |
| `webhooks` | `webhooks`, `webhook_deliveries`, `jobs` |
| push notifications | `notifications` + SSE |

## Endpoints

| Legacy | New |
|---|---|
| `GET /v1/funnels`, `/funnelfilters` | `GET /api/funnels`, `/api/funnels/filters` |
| `POST /v1/funnels`, `GET/PUT/DELETE /:id` | `POST /api/funnels`, `GET/PATCH|PUT/DELETE /api/funnels/:id` (delete is soft) |
| `POST /:id/duplicate` | `POST /api/funnels/:id/duplicate` |
| step create/update/delete/duplicate, `PUT /:id/orders` | `/api/funnels/:id/steps...`, `PUT /steps/order` |
| `PUT /:id/step/:sid` (builder save) | `PUT /api/funnels/:id/steps/:sid/page` |
| `getbackups`, `getrollbackversion` | `GET .../backups`, `GET .../backups/:bid`, `POST .../backups/:bid/restore` |
| `POST /validatepath` | `POST /api/funnels/validate-path` |
| `/tags` | `/api/tags` |
| `/global/templates/*` | `GET /api/templates`, `/:id`, `POST /:id/use`; admin under `/api/admin/*` |
| `/blocks/*` | `/api/blocks` |
| `/e/cloudflare/hosts`, `PUT /funnels/domains/:id` | `/api/domains`, `POST /:id/verify`, `PUT /:id/default-pages`, `GET /:id/routes` |
| `GET /funnelpreview` (no auth) | `POST /api/funnels/:id/preview-token` + `GET /preview/:id/*?token=` |
| `GET/POST /funnelstepcloudlflare` | removed; `hostRouting` serves pages |
| `POST /v1/funnels/analytics` | `POST /api/public/events` (page_view, optin only) |
| `GET /analytics/:funnel/:step` | `GET /api/funnels/:id/analytics`, `.../steps/:sid/analytics` |
| `/:id/forms`, `/forms/export` | `GET /api/leads?funnelId=`, `/api/leads/export` |
| `/sales/*` | `GET /api/orders`, `/api/orders/export`; checkout `POST /api/public/checkout/...` |
| `DELETE /:id/cache_purge` | automatic invalidation on save |
| `POST /v1/public/billing/checkout` | `PaymentProvider` + mock |

## Legacy bugs and quirks deliberately not carried over

1. Hard delete only, with orphaned components rows and analytics left behind. Now soft delete + restore + owner purge (cascading).
2. Reorder accepted partial and non-contiguous sets. Now complete, unique, normalised to 1..n.
3. `updateFunnel` returned steps sorted by `createdAt`; everything sorts by `position`.
4. HMAC verification bypassed when the secret was unset. The edge worker no longer exists; previews use signed tokens that always require the server secret.
5. `getFunnelPreview` had no authentication. Previews need a minted token that expires.
6. Public analytics POST had no rate limiting or bot filtering and trusted client `unique_visit` and sale items. Now rate limited, bot filtered, server decides uniqueness, and browsers cannot report orders.
7. Tag delete `updateMany` was not account-scoped. Scoped to the workspace and 404 for foreign ids.
8. `deleteFunnel` deleted steps before checking the account. All queries are workspace-scoped.
9. `site_id` held the funnel id in the API but the step id in a meta tag. Explicit `funnel_id`/`step_id` everywhere.
10. Retention of 10 backups relied on a nightly cron. Pruned in the save transaction.
11. `last_updated_by` stored the account id. Backups record the user id.
12. Overloaded analytics row type inferred from nullable fields. Separate `events.type`.
13. Domain deletion cascade was spread over queues. One transaction.
14. Template admin gated by hard-coded hostnames and per-user flags. `PLATFORM_ADMIN_EMAILS`.
15. Path regex let the last character be anything except `/` and `.`. Control characters, whitespace, `?`, `#`, `\` are rejected too.
16. GET used for a mutation (`/global/templates/save`). Mutations use POST.
17. Funnel creation did not check cross-funnel path conflicts. Creating onto a domain runs the same check and resolution flow.
18. Dead code not migrated: `updatePageSettings`, `uploadtoWasabi` route publishing, beacon `trackEvent`, `funnels.domains`, unused template collections.

## Left out on purpose

Live chat widget and support tokens, split testing (never existed), the URL shortener and share page, subaccount duplication and the async clone pipeline with image/form copying, Puppeteer thumbnails, media gallery (Wasabi), Form.io forms (replaced by native form blocks), Stripe Connect (replaced by the `PaymentProvider` seam), push notifications (replaced by in-app feed and SSE), white-label domains.

## Edge serving (phase 2)

The legacy Cloudflare worker called `GET /funnelstepcloudlflare` with an HMAC that was skipped when the secret was unset, and wrote HTML back with `POST`. The replacement worker in `edge/` calls `GET /internal/edge/resolve` (read-only, HMAC mandatory, timestamp window, nonce replay protection, fail closed) and never writes to the origin; cache purge is driven by the origin through the Cloudflare API. Cloudflare custom hostnames (legacy `lightning.domains`) map to `DomainProvider` `cloudflare`.

## Access control (phase 3)

Not a legacy migration but a behaviour change for anyone running an earlier build of this app:

* **Everyone signs in once after the upgrade.** Access tokens now carry a session id; tokens issued before (no session id) are rejected.
* **`POST /api/members` (temporary password) is gone.** Use `POST /api/invitations` (one-time link by mail). `PATCH /api/members/{id}` takes `{ roleId }` instead of `{ role }`.
* **Roles are permission sets.** Existing users keep their role: `users.role_id` is filled from `users.role` (owner, admin, member), so nobody gains or loses access. New built-in role `viewer`. The legacy `users.role` column stays and mirrors the built-in role (`member` for custom roles and viewers).
* **A workspace can have several owners**, and the last owner can no longer be demoted (previously the owner role was frozen).
* Access tokens default to 15 minutes (was 12 hours); the web app renews them with the refresh token.
