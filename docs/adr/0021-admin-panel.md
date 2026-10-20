# 0021. Admin panel: platform administrators, suspension, support access, flags

Status: Accepted

## Context

Operating the product needs actions no workspace role may have: stopping an abusive workspace everywhere (including at the CDN), looking at a customer's account to help them, switching features per workspace, inspecting the queues, answering data-subject requests, telling users about incidents. Until now "platform admin" was a list of emails in configuration checked inside some handlers.

## Decision

* **Identity:** a `platform_admins` table is the source of truth; `PLATFORM_ADMIN_EMAILS` bootstraps the first administrators (lazy, audited) and revokes bootstrap rows when the address leaves the list. One central check in `authenticate()` for every `auth: 'platform'` route replaces per-handler checks: administrator, not impersonating, and two-factor enabled when `ADMIN_REQUIRE_2FA` (forced on in production, not configurable there).
* **Suspension is a column, enforced where requests enter:** `workspaces.suspended_at`. Sessions are revoked once; every later authenticated call re-reads the row in the query that already loads the user; public paths use a 5-second in-process cache. The edge is told by a queued purge of the live URLs, and the edge resolve answers missing. Money in flight is allowed to finish.
* **Impersonation is a session, not a token swap:** a `sessions` row with `impersonator_id`, no refresh token, expiry equal to the access token's. Its permissions are the user's minus a deny list, credential routes are closed, admin routes are closed, every write is audited with the administrator in the workspace's own audit log. Administrators cannot be impersonated.
* **Flags:** override, then stable-hash percentage, then default; built-in flags in code so a fresh install needs no rows; 5-second per-workspace cache.
* **GDPR:** erasure anonymises financial rows rather than deleting them, records a digest rather than the address, and refuses to delete a member account implicitly; workspace export streams in keyset pages.
* **Queue inspector** reads the existing tables and bus interface; the only writes are retry and discard of dead jobs.
* **Announcements** are rows with a window and a per-user dismissal; critical ones cannot be dismissed.

## Alternatives considered

A separate admin application with its own login (stronger isolation, but a second auth stack and no reuse of the audit and rate-limit machinery); impersonation by minting a normal session with the user's full rights (simpler, but support staff could change passwords, billing and ownership); suspension by deleting domains or revoking keys one by one (not atomic, loses configuration, no clean undo); deleting orders on erasure (breaks accounting and refunds); flag evaluation per request from the database (a read per request on hot paths).

## Consequences

A suspension takes up to 5 seconds to be complete across nodes and the edge may serve a cached page until the purge job runs (retried with backoff; a Cloudflare outage delays it). Impersonation widens what support can see, which is why it is reasoned, time-limited, visible to the customer and audited. Administrators who lose their authenticator are locked out of admin routes in production until someone with database access resolves it (see RUNBOOK). The edge Worker is unchanged; Cloudflare purge by URL does not remove a page cached under a URL the app never saw.
