# Admin area (platform administration)

For the people who run a Funnels installation, not for workspace owners. Everything lives under `/api/admin` (declared `auth: 'platform'` in `server/src/routes/spec.ts`) and in the web app under `/admin`. Decision record: [ADR 0021](adr/0021-admin-panel.md).

## Who is an administrator

The `platform_admins` table decides. `PLATFORM_ADMIN_EMAILS` only bootstraps: a listed user who signs in and opens an admin route gets a row (source `bootstrap`, audited as `admin.bootstrap`); taking the address off the list revokes that row on the next request. Administrators added in the admin area (`POST /api/admin/admins`, an existing user's email) have source `admin` and do not depend on the list. A bootstrap administrator cannot be removed in the UI, nobody can remove themselves, and a workspace role never makes someone an administrator.

Every platform route is checked in one place (`authenticate()` calls `assertPlatformAccess`, `server/src/auth/platform.ts`):

1. the caller is an administrator;
2. the session is not an impersonation session;
3. when `ADMIN_REQUIRE_2FA` is on, the account has confirmed two-factor authentication. **In production it is always on** and cannot be switched off (`loadConfig` forces it). Sign-in already demands the second factor for accounts that have one, so "enabled" means this session passed it. An administrator without 2FA gets `403 ADMIN_2FA_REQUIRED` and can only enrol (Settings, Security).

All admin routes are rate limited per user (`admin.platform`) and every state change writes `audit_log` with the administrator's id (action names `admin.*`).

## Platform roles at a glance

`support` administrators can see everything the admin area shows and look at any customer workspace read-only; `superadmin` administrators can additionally open write-enabled support sessions and make other superadmins. Details under [Platform roles](#platform-roles).

## Workspaces

`GET /api/admin/workspaces` searches by workspace name, id or member email (keyset pages) and filters by status; `GET /api/admin/workspaces/:id` shows plan, usage against limits, members (with 2FA status), flag overrides and recent audit.

### Suspend and unsuspend

`POST /api/admin/workspaces/:id/suspend {reason}` (reason of at least 5 characters, recorded):

| Surface | Effect |
|---|---|
| Members | all sessions revoked; sign-in still works, but every route except `GET /api/auth/me`, `POST /api/auth/logout` and `GET /api/announcements` answers `403 WORKSPACE_SUSPENDED`; the web app shows why |
| Customer domains | the origin answers `503 Site unavailable`; the edge resolve answers `missing` |
| Edge cache | an `edge.purge` job is queued for every live page URL of the workspace (Cloudflare purge by URL; with `NoopPurger` nothing is sent) |
| Public forms, checkout | `503 SITE_UNAVAILABLE` |
| Public events | accepted and dropped (`reason: suspended`) |
| API keys | `403 WORKSPACE_SUSPENDED` |
| Previews | `503` page |
| Not stopped | a Stripe payment already in flight is still finalized (the customer paid and must get an order); webhook deliveries already queued are still delivered; the platform subscription is not cancelled |

The decision is read from the database on every authenticated call and cached for 5 seconds in-process for the public paths, so on a multi-node installation a suspension is complete everywhere within 5 seconds. You cannot suspend your own workspace. `POST .../unsuspend` lifts it (members sign in again; nothing was deleted).

### Impersonation (support access)

`POST /api/admin/workspaces/:id/impersonate {reason, userId?, allow_writes?}` returns an access token for the workspace owner (or the named member). **A support session is read-only by default.**

| | Read-only (default) | `allow_writes: true` |
|---|---|---|
| Who may open it | any platform administrator | only the `superadmin` platform role (`403 SUPERADMIN_REQUIRED` for `support`) |
| Reason | at least 5 characters | at least 20 characters (`400 WRITE_REASON_REQUIRED`): say what will change and why |
| Lifetime | `IMPERSONATION_TTL_MINUTES` (default 30, max 240) | `IMPERSONATION_WRITE_TTL_MINUTES` (default 10, max 60), never longer than the read-only lifetime |
| GET / HEAD | allowed | allowed |
| POST, PUT, PATCH, DELETE | `403 IMPERSONATION_READ_ONLY` before any handler or permission check runs (also for unknown routes) | allowed within the permissions below, each one audited |
| Banner in the web app | notice: "Support access (read-only)" | red alert: "Support access with WRITE permission", states that every change is recorded |
| `GET /api/auth/me` | `impersonation: {by, expiresAt, readOnly: true, allowWrites: false}` | `readOnly: false, allowWrites: true` |

The only non-read requests a read-only session may make are ending itself (`POST /api/auth/logout`) and opening the notification stream (`POST /api/events/ticket`; it changes no data). The list is `IMPERSONATION_SAFE` in `server/src/auth/context.ts`.

Properties of every support session:

* reason required, shown to the workspace: `admin.impersonation.started` is written into **the workspace's** audit log with the reason, the administrator's id and `mode` (`read_only` or `read_write`); logout writes `admin.impersonation.ended`;
* no refresh token, cannot be extended; logout ends it early; it simply stops working at its expiry (401);
* it cannot open the admin area (`403 IMPERSONATION_FORBIDDEN`), change credentials (password, 2FA, sessions), and the user's permissions are reduced by `IMPERSONATION_DENIED` (`billing:manage`, `orders:refund`, `members:manage`, `roles:manage`, `workspace:manage`, `api_keys:manage`, `analytics_identity:manage`, `funnels:purge`), whatever role the user has, writes enabled or not;
* in a write-enabled session every write that passes the permission check is audited as `admin.impersonation.action` (method, route pattern, session id, administrator id) in the workspace's log; a request refused by the permission check is not recorded as a change;
* the customer-facing audit log (`GET /api/audit`, the Audit page) marks these rows with `supportAccess: true` and a `label` ("Support access started", "Support access: change made", "Support access ended"); `actorId` is the administrator's user id, not one of the customer's members;
* administrators cannot be impersonated; a suspended workspace cannot be acted in.

### Platform roles

`platform_admins.role` is `support` or `superadmin` (migration 015). Administrators from `PLATFORM_ADMIN_EMAILS` (bootstrap rows, including those that existed before the migration) are `superadmin`; administrators added with `POST /api/admin/admins {email, role?}` are `support` unless `role: "superadmin"` is given, which only a superadmin may do (`403 SUPERADMIN_REQUIRED`). There is no endpoint to change a role: remove and add again. `GET /api/admin/admins` and `GET /api/auth/me` (`platformRole`) report it. Both roles can use every other admin function; the role only gates write-enabled support sessions and granting superadmin. Existing administrators added through the API before migration 015 become `support`: a superadmin has to re-add them to restore write access.

The web app shows the banner above, and the "Act as owner" dialog offers "Allow changes" only to superadmins.

### Delete a workspace

`DELETE /api/admin/workspaces/:id {confirmName, reason}`. Guard rails: the workspace must be suspended first, the exact name must be typed, nobody in it may be an administrator, and an active Funnels subscription must be cancelled first (`409 HAS_SUBSCRIPTION`). Foreign keys cascade through funnels, steps, pages, events, leads, orders, members, keys. The audit rows of the workspace stay (including `admin.workspace.deleted` with who and why). Cloudflare custom hostnames are removed. **Not removed:** Stripe objects, backups, webhook receivers' copies, queued jobs that mention the workspace (they fail and dead-letter).

## Personal data (GDPR)

* `POST /api/admin/gdpr/export {email, workspaceId?}`: every lead, order and checkout session for that address (up to 1000 each).
* `POST /api/admin/gdpr/erase {email, workspaceId?}`: leads deleted (events keep a null lead id); orders and checkout sessions anonymised in place (email becomes `erased-<digest>@erased.invalid`, name, payment method, customer reference, visitor id and UTMs removed; amounts, products, dates and the payment reference stay so refunds and the books still work); notifications mentioning the address deleted; webhook delivery payloads mentioning it blanked (queued ones are dead-lettered). The audit row carries a 12-character digest of the address, never the address. If the address belongs to a workspace member the answer says so and the account is left alone (remove the member from their workspace instead).
* `GET /api/admin/workspaces/:id/export`: the whole workspace as NDJSON (`{"table","row"}` per line: workspace, users, roles, domains, funnels, steps, step pages, leads, orders, refunds, webhooks, audit), streamed in keyset pages of 1000 so memory stays flat (tested with 2300 rows); no password hashes, key hashes, secrets or raw events (use the [analytics export](ANALYTICS-API.md) for events).

Out of scope here: data inside Stripe (delete the customer there), customers' own systems that received webhooks, database backups (age out per your retention), the audit log's user ids and IPs for workspace members.

## Feature flags

A flag is evaluated per workspace: explicit override, then percentage rollout (stable hash of flag and workspace; raising the percentage only adds workspaces), then the default. Built-in flags exist without a row at their built-in default: `ai_assistant` (gates `/api/ai/*`) and `analytics_api` (gates the API-key routes), both default on, so one can be switched off for one workspace or for everyone. `GET /api/workspace/flags` returns the evaluated flags for the caller's workspace. Flags are cached 5 seconds per workspace in-process. Add a flag in code by calling `requireFlag(deps, ws, 'key')` or `flagEnabled(...)` and listing it in `KNOWN_FLAGS` if it should have a default without a row.

## Queue inspector

`GET /api/admin/queues`: jobs by status and type with the age of the oldest, outbox backlog and oldest age, event bus kind with lag and dead-letter count for each consumer group this node runs (`ingest` when `INGEST_QUEUE`, `clickhouse` when mirroring), undelivered webhook deliveries, event buffer depth. `GET .../dead-jobs` and `.../dead-letters` list failures with payloads truncated to 2000 characters (payloads can contain personal data; only administrators see them). `POST .../jobs/:id/retry` re-queues a dead job, `DELETE .../jobs/:id` discards one; both refuse jobs that are not dead. Lists show at most `ADMIN_QUEUE_PEEK` rows.

## Announcements

`/api/admin/announcements` (list, create, edit, delete): title, body, level (`info`, `warning`, `critical`), start and optional end. Every signed-in user sees active ones as a banner (`GET /api/announcements`, critical first); users dismiss non-critical ones (`POST /api/announcements/:id/dismiss`), critical ones stay until they end. Suspended members also see them.

## Platform audit

`GET /api/admin/audit` across all workspaces: filter by workspace, actor, action (exact, or a prefix with a trailing `*` such as `admin.*`) and time, keyset paged. Workspace owners see their own rows through `/api/audit` ([RBAC.md](RBAC.md)).

## What is not here

No billing console beyond the plan shown per workspace (change plans in Stripe; the rate-tier override in [RATE-LIMITING.md](RATE-LIMITING.md) is separate), no bulk actions, no admin-initiated password reset, no two-person approval for write-enabled support sessions, no per-session scope narrower than the user's permissions, no two-person approval for deletion. Browser tests: `e2e/tests/admin.spec.ts`; server tests: `server/test/admin.test.ts` (all engines).
