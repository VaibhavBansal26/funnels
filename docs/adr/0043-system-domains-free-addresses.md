# 0043. Free addresses as system domains

Status: Accepted (going live on a pages.dev address verified on a real Cloudflare account; other Cloudflare parts only against a fake, see [CLOUDFLARE-PAGES.md](../CLOUDFLARE-PAGES.md))

## Context

Going live required an active custom domain (`DOMAIN_NOT_ADDED`), and the Cloudflare Pages target required one too, so a person without a domain could never publish. Every Pages project already has a free `<project>.pages.dev` address, and the app itself can serve a funnel from its own host.

## Decision

* An address is a row in `domains` with a `kind`: `custom` (a hostname the customer owns, verified through DNS), `builtin` (one per workspace; the funnel is served by this app under a path prefix) or `pages` (one per funnel published to Cloudflare Pages; the host is `funnel_publish.pages_host`). The funnel keeps pointing at it with `funnels.domain_id`, so the state machine (live needs an attached, usable domain) and the revert rules stay one mechanism.
* System domains use a synthetic `.invalid` hostname, so they can not match a `Host` header, and every host lookup (`hostRouting`, `resolveLive`, CORS) filters on `kind = 'custom'`. They are hidden from the Domains API (404), excluded from plan limits, and `*.pages.dev`, `*.workers.dev` and `*.invalid` can not be registered as customer domains.
* The `pages` domain is `pending` until the first deployment succeeds. A funnel may be set live on a pending pages domain of its own (publishing intent), and a failed first deployment leaves it live and pending: the UI derives one visible state (test mode, publishing, live, failed, paused) from funnel, domain and deployment history rather than adding a status column that could disagree.
* Switching the target away from Pages, removing the connection or deleting the project removes the pages domain and returns the funnel to test; choosing another project name resets it to pending with the new host.
* Cloudflare allows 100 Pages projects per account and the app makes one per funnel: the account's project count is read through the API before a project is created, and the refusal is a specific error. Sharing one project between funnels was reconsidered and rejected for now (one deployment for several funnels would couple their failures and rollbacks).

## Alternatives considered

A separate `addresses` table (a second place the state machine and revert rules must look at); virtual domain ids (`'builtin'`) without rows (no foreign key, no place for status); putting the pages.dev host into `domains.hostname` (two workspaces with the same project name in different accounts would collide on the unique index); auto-publishing every funnel to the built-in address (publishing must stay an explicit act).

## Consequences

One more column on `domains` and a rule everywhere hostnames are looked up. The Domains page and plan limits must keep filtering on `kind`.
