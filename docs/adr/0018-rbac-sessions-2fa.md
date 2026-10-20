# 0018. Permission-based RBAC, sessions with rotating refresh tokens, TOTP 2FA

Status: Accepted

## Context

Authorization was a three-step hierarchy (`owner > admin > member`) checked by a `requireRole` middleware that each route file applied by hand, and the route declaration only repeated the level. Members were created with a temporary password handed over by the owner. A JWT lived 12 hours with no way to end it. There was no second factor, password reset, invitation flow or audit trail for security events, and the owner role was frozen.

## Decision

* **Permissions, not levels.** A role is a set of permissions from a fixed catalogue (`auth/permissions.ts`). Built-in roles (owner, admin, member, viewer) are code; custom roles are rows per workspace. Each authenticated route declares exactly one permission in `routes/spec.ts` and `authenticate()` enforces it centrally; the per-route middlewares are gone. A generated test matrix calls every route with a role lacking exactly its permission and with a role holding only it.
* **No escalation:** grant, edit, assign or act on only what you hold yourself; last owner protected; built-in roles immutable.
* **Sessions.** Access token = short JWT with a session id (checked against `sessions` on every request, together with the user and role, in one query); refresh token = opaque, hashed at rest, rotated on every use, reuse outside a short grace window revokes the session.
* **Invitations and reset** by one-time hashed tokens; same answers for unknown addresses; per-address and per-IP budgets. Mail goes through a transport interface with a webhook implementation (no SMTP dependency).
* **TOTP** implemented on `node:crypto` (RFC 6238), secrets encrypted with AES-256-GCM, replay blocked by remembering the last accepted step, recovery codes hashed, failures counted in the existing lockout budget.
* **Audit log** extends the existing `audit_log` table with target and IP, with a paginated read API.

## Alternatives considered

Keeping role levels and adding a few flags (cannot express "may export leads but not read orders"); attribute-based or per-resource permissions (more power than a funnel builder needs, much harder to test exhaustively); stateless access tokens with a denylist (a lookup per request anyway, and the user and role are loaded per request already); httpOnly cookies (CSRF protection needed, and the API is also used by scripts); an SMTP or provider SDK (a dependency and credentials in the app; the webhook bridge keeps the choice with the operator); storing roles in the token (stale until expiry).

## Consequences

One extra join per request (user, role, session) and a `last_used_at` write at most every five minutes per session. Role changes and revocations apply on the next request. Tokens issued before the change are rejected once (everyone signs in again). Built-in role definitions are code, so changing them affects every workspace at the next deploy. Mail delivery depends on the operator providing a transport; without one the invitation link is shown to the inviter and password reset cannot be delivered. TOTP secrets are unreadable if `DATA_ENCRYPTION_KEY` changes (users re-enrol). Tokens remain in browser `localStorage`.
