# 0045. The built-in address: a path prefix on the app's own host

Status: Accepted

## Context

Going live needed a domain the user owns. A free way to test and deploy was needed that works without DNS or a third-party account, on the single host a free Render deployment has.

## Decision

* Address: `<APP_PUBLIC_URL>/s/<workspace slug>/<funnel slug>/<step path>`. Slugs are 1 to 40 characters of `[a-z0-9]` and single hyphens, generated from names on first use, unique (workspaces globally, funnels per workspace), stable on rename, editable by the owner. A change breaks the old URL on purpose: there is no redirect table to keep consistent.
* It is a system domain (ADR 0043) of kind `builtin`, one per workspace, always active, so the funnel state machine, revert rules and Domain dropdown stay one mechanism.
* **Links are not rewritten after the fact.** The renderer receives each step's href from the funnel (`prefix + step path`), so a prefix is a render input like any other. Stored HTML is therefore per address: it is regenerated when the address, a slug or the workspace slug changes (`mountOf` and `mountKey` detect the change). String replacement over user content was rejected: it can corrupt content and miss attributes.
* Everything that built an absolute URL from a hostname (checkout success/cancel, conversion page URL, purge list) goes through `stepUrls`/`addressFrom`, which know the three kinds of address.
* **Security.** The pages share an origin with the admin app. Pages with owner-authored code are served under a CSP `sandbox` without `allow-same-origin`; the beacon degrades to in-memory ids. Cookies are scoped to `/s/<workspace>`. Pages without owner code get an exact CSP computed with the same function as the Cloudflare Pages bundle. `noindex` by default with a per-funnel toggle (a header, so the toggle does not need a re-render).
* Edge: the signed resolve endpoint accepts the app host for `/s/` paths only and returns cookie path and headers; the worker applies a closed allow-list of headers.

## Alternatives considered

A wildcard subdomain per workspace (`<ws>.apps.example.com`: real origin isolation and no prefix problems, but needs wildcard DNS and TLS the free single-host deployment does not have; documented as the better production arrangement, `kind` can grow a third form); query-string routing; rewriting links by regular expression at serve time; sandboxing every built-in page (breaks first-party cookies for pixels on pages that are safe); not sandboxing at all (an admin opening a tenant's page would run the tenant's script as the admin).

## Consequences

Same-origin hosting stays a weaker boundary than a separate origin: a sanitiser bypass would run on the app's origin for code-free pages. Pixel cookies on sandboxed pages are unavailable. The path prefix must be handled by every new feature that emits URLs; tests in `builtin.address.test.ts` cover links, forms, checkout, cookies, redirects, caching and the edge.
