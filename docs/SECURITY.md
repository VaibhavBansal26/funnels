# Security

## Reporting a vulnerability

Do not open a public issue. Contact the maintainers privately (a private repository security advisory, or the maintainer contact in the repository profile) with a description, impact and steps to reproduce. There is no bug bounty and no committed response time in this repository; treat that as something the operating organisation defines.

## What the system protects

| Data | Where | Sensitivity |
|---|---|---|
| Accounts: email, name, scrypt password hash, role | `users` | personal data; hashes never leave the server |
| Sessions (device, IP), refresh-token hashes, invitation and reset token hashes, encrypted TOTP secrets and hashed recovery codes, audit log (actor, IP) | `sessions`, `refresh_tokens`, `invitations`, `password_resets`, `user_totp`, `recovery_codes`, `audit_log` | personal data (IP, user agent, email); tokens only as hashes; TOTP secrets AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY`; trim `sessions` and `audit_log` to your retention policy |
| Leads: email, name, phone, submitted fields, UTM | `leads`, `events` | personal data of the customers' visitors; the main PII store |
| Orders: buyer email/name, amounts, provider reference, payment method reference | `orders` | personal and financial (no card numbers; the payment provider holds them) |
| Visitor ids (random cookie value), page URLs, UTM | `events` | pseudonymous identifiers |
| Client IP addresses | rate limiter keys in Redis/memory (readable, TTL'd), request logs | personal data; not written to the database |
| Webhook signing secrets, verification tokens | `webhooks`, `domains` | secrets stored in the database in clear (needed to sign); protect database access and backups |
| JWT secret, edge secret, Cloudflare/Anthropic tokens | environment | secrets |

PII policy: collect only what forms ask for; exports (CSV) are workspace-scoped and neutralise formula injection; logs carry request ids, paths and status, never bodies, tokens or form data; rate limiter keys hash every identifier except IP addresses and expire on their own; deleting a funnel's data is `DELETE .../purge` (cascades to events and orders). There is no automatic per-lead erasure endpoint yet (known gap for GDPR "right to erasure": delete via the database or add the endpoint).

## Threat model summary

| Threat | Mitigation | Residual |
|---|---|---|
| Cross-tenant access | every query is scoped by `workspace_id` in the repository layer; a foreign id is a 404 (no existence leak); tests cover every resource type | a missed scope in new code; the tenancy suite and the route declaration tests are the guard |
| Stored XSS in pages | block renderer escapes; allow-list sanitiser for custom HTML; URL scheme allow-lists; scripts only for owner saves with the workspace flag | custom scripts are by design arbitrary JS on the customer's own pages |
| SSRF through webhooks | blocked address ranges, DNS resolved and pinned, redirects not followed, no credentials in URLs | none known beyond the tested table |
| Credential stuffing, brute force | scrypt, per-IP limiter with penalty box (fail closed), failed-login lockout per account and IP, constant-time dummy hash for unknown emails | distributed low-and-slow attacks across many IPs against many accounts |
| Forged client IP to dodge limits | `CF-Connecting-IP` only with the origin secret or from Cloudflare ranges; `X-Forwarded-For` counted from the right | a misconfigured `TRUST_PROXY` |
| Flooding the public endpoints | Cloudflare WAF rules, Worker limiter, origin limiter per IP and funnel, body size limits | volumetric attacks need Cloudflare/your provider |
| Forged revenue | browsers cannot post orders; prices come from stored blocks | none known |
| Replay/forgery of edge calls | HMAC with timestamp and nonce, 120 s window, fail closed without a secret | nonce cache is per process |
| Token theft | HS256 with a `use` claim (access, preview, stream ticket, 2FA challenge); access tokens last 15 minutes and carry a session id checked on every request, so revoking a session ends its tokens at once; refresh tokens rotate and reuse revokes the session | tokens live in browser `localStorage` (an XSS flaw would expose them; the SPA CSP is the mitigation) |
| Credential stuffing, 2FA brute force | per-account and per-IP failure budgets in sliding windows, checked before any password or code; TOTP codes work once; recovery codes work once | an attacker rotating IPs against one account is limited by the per-account budget (8 per 15 min), which also locks the real user out for that time |
| Privilege escalation | permission-based roles; nobody can grant, edit or act on more than they hold; built-in roles are immutable; last owner protected | roles apply to a whole workspace, not to single resources |
| CSV/formula injection | cells starting with `= + - @` are prefixed | none known |
| Leaked secrets | none in the repository; `.env.example` is blank | operator handling |
| Redis outage | policies fail open or closed deliberately | a fail-open outage removes limiter protection (edge layer remains) |

## Authentication and authorisation

Email and password (scrypt, per-user salt), optional TOTP two-factor authentication, sessions with rotating refresh tokens, invitations and password reset by one-time links (hashes stored), JWT access tokens (`jose`, HS256). Authorization is permission-based: `server/src/routes/spec.ts` declares one permission per route, `authenticate()` enforces it, and a generated test matrix proves every route refuses a role without exactly that permission ([RBAC.md](RBAC.md)). An audit log records the security-relevant actions. Platform administrators are an allow-list of emails in configuration, separate from workspace roles.

## Network and transport

TLS is terminated in front (Cloudflare, a load balancer). Set `TRUST_PROXY` and `TRUSTED_PROXY_HOPS` to match, restrict `/internal/*` to the Worker (WAF rule in docs/CLOUDFLARE.md), keep `/metrics` private or protected with `METRICS_TOKEN`. Security headers: `nosniff`, `referrer-policy`, CSP on the SPA shell; published pages intentionally have no CSP (customers add tracking snippets).

## Dependencies

`npm audit --omit=dev` runs in CI for the server, web and edge. Dev-only tooling (vitest, tsx, mermaid, fast-check, pglite) is not shipped.
