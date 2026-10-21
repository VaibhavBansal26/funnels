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
| Ad network access tokens (Meta, GA4 API secret, TikTok), Cloudflare API token | `ad_integrations`, `publish_credentials` | secrets, AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY` (key id in the ciphertext, bound to the row), masked in every API response, never logged or audited |
| Attribution: visitor id, UTM and click ids, `fbp`/`fbc`/GA ids, IP address and user agent (last two expire) | `visitor_attribution`, `leads`, `orders` | pseudonymous identifiers plus personal data (IP, user agent) kept only for server-side conversions: `ATTRIBUTION_RETENTION_DAYS` (90) |
| Webhook signing secrets, verification tokens | `webhooks`, `domains` | secrets stored in the database in clear (needed to sign); protect database access and backups |
| JWT secret, edge secret, Cloudflare/Anthropic tokens | environment | secrets |

PII policy: collect only what forms ask for; exports (CSV) are workspace-scoped and neutralise formula injection; logs carry request ids, paths and status, never bodies, tokens or form data; rate limiter keys hash every identifier except IP addresses and expire on their own; deleting a funnel's data is `DELETE .../purge` (cascades to events and orders). There is no automatic per-lead erasure endpoint yet (known gap for GDPR "right to erasure": delete via the database or add the endpoint).

## Threat model summary

| Threat | Mitigation | Residual |
|---|---|---|
| Cross-tenant access | every query is scoped by `workspace_id` in the repository layer; a foreign id is a 404 (no existence leak); tests cover every resource type | a missed scope in new code; the tenancy suite and the route declaration tests are the guard |
| Stored XSS in pages | the server rebuilds every saved project from allow-lists, escapes in the renderer, runs `sanitize-html` and `postcss` over the result, and only an owner of a workspace with the scripts flag can author a script at all; the editor canvas and the previews are sandboxed ([details](#page-builder-and-published-pages)) | custom scripts are by design arbitrary JS on the customer's own pages |
| SSRF through webhooks | blocked address ranges, DNS resolved and pinned, redirects not followed, no credentials in URLs | none known beyond the tested table |
| Credential stuffing, brute force | scrypt, per-IP limiter with penalty box (fail closed), failed-login lockout per account and IP, constant-time dummy hash for unknown emails | distributed low-and-slow attacks across many IPs against many accounts |
| Forged client IP to dodge limits | `CF-Connecting-IP` only with the origin secret or from Cloudflare ranges; `X-Forwarded-For` counted from the right | a misconfigured `TRUST_PROXY` |
| Flooding the public endpoints | Cloudflare WAF rules, Worker limiter, origin limiter per IP and funnel, body size limits | volumetric attacks need Cloudflare/your provider |
| Forged revenue | browsers cannot post orders; prices come from the `products` list the server derives from the saved page, never from the request | none known |
| Replay/forgery of edge calls | HMAC with timestamp and nonce, 120 s window, fail closed without a secret | nonce cache is per process |
| Token theft | HS256 with a `use` claim (access, preview, stream ticket, 2FA challenge); access tokens last 15 minutes and carry a session id checked on every request, so revoking a session ends its tokens at once; refresh tokens rotate and reuse revokes the session | tokens live in browser `localStorage` (an XSS flaw would expose them; the SPA CSP is the mitigation) |
| Credential stuffing, 2FA brute force | per-account and per-IP failure budgets in sliding windows, checked before any password or code; TOTP codes work once; recovery codes work once | an attacker rotating IPs against one account is limited by the per-account budget (8 per 15 min), which also locks the real user out for that time |
| Privilege escalation | permission-based roles; nobody can grant, edit or act on more than they hold; built-in roles are immutable; last owner protected | roles apply to a whole workspace, not to single resources |
| CSV/formula injection | cells starting with `= + - @` are prefixed | none known |
| Leaked secrets | none in the repository; `.env.example` is blank | operator handling |
| Pixel snippet injection (script text pasted as a tag ID) | pixel IDs are validated against strict per-network formats on save and at render; the snippet is generated by the server and its configuration is JSON-escaped | none known beyond the corpus in `ads.pixels.test.ts` |
| Ad spend CSV: formula injection, oversized or hostile files | formula-like cells are neutralised on every export; 2 MB and `ADS_IMPORT_MAX_ROWS` caps; strict row validation | none known |
| Cloudflare token theft or abuse | encrypted at rest, masked, scoped to Pages Edit, audited, redacted from stored errors; the app never overwrites a project it did not create without confirmation and never deletes one it did not create | the token holds what you granted it: use a dedicated token |
| Forged cross-origin reads of the public API | CORS allow-list (customer domains, Pages hosts, this app); rate limits unchanged | any client can still POST; the endpoints validate everything |
| Redis outage | policies fail open or closed deliberately | a fail-open outage removes limiter protection (edge layer remains) |

## Page builder and published pages

The builder stores GrapesJS project data and the server publishes HTML rendered from it. Legacy pages were client-rendered HTML that the server trusted; **it does not trust the client any more**: the browser sends project JSON only, never HTML or CSS, and a hostile client can send anything it likes without changing what is allowed to reach a visitor.

| Layer | What it does | Where |
|---|---|---|
| 1. Allow-list rebuild | `cleanProject` rebuilds every node from scratch: known component types, tags, attributes, class names, ids, style properties and values, selectors and media text. Unknown keys, event-handler attributes, `style` strings with `url(javascript:...)`, `expression()`, `@import`, and so on are dropped, not escaped. The output is idempotent (cleaning twice changes nothing). | `server/src/pagemodel/shared/clean.ts`, `cssvalues.ts` |
| 2. Typed props | Forms, checkouts, video, countdown, progress and button actions are validated with zod (field types and counts, URL schemes, video hosts, price range, currency); the markup is generated from the props. | `shared/props.ts`, `shared/markup.ts` |
| 3. Limits | 3,000 components, depth 24, 6,000 CSS rules, 2 MB per document (`413 DOCUMENT_TOO_LARGE`), 10,000 characters per text, 2,000 per attribute. | `PROJECT_LIMITS` in `clean.ts`, `services/pages.ts` |
| 4. Escaping | The renderer escapes text and attribute values. | `render.ts`, `markup.ts` |
| 5. `sanitize-html` | A final pass over the whole rendered body, with tag, attribute and URL-scheme allow-lists (`http`, `https`, `mailto`, `tel`, relative; `data:` only on images). | `htmlfilter.ts` |
| 6. `postcss` | Free-form CSS (page CSS, class rules) is parsed and re-serialised from an allow-list of properties and values. `expression()`, `behavior`, `-moz-binding`, `javascript:` and `image-set()` / `src()` / `attr()` values are removed; `url()` accepts only `https:`, `http:`, same-site `/paths` and base64 PNG, JPEG, GIF or WebP data URIs (at most 400 KB); `@import` is kept only for Google Fonts stylesheets. | `cssfilter.ts` |
| 7. Custom code | The *Custom code* block's HTML and CSS go through layers 5 and 6 unless the saver is the owner of a workspace with `allowCustomScripts`. A non-permitted saver cannot add or change a code block or tracking code: the server keeps the previous (owner-saved) block byte for byte or removes the new one. The UI hides the block, the server enforces the rule. | `pagemodel/doc.ts`, `services/pages.ts` |

**Price integrity.** `products` and `forms` are derived from the cleaned project on the server at every save. The public checkout endpoint looks the offer up in `products` and charges that amount; the request body carries only the buyer's email and name. A tampered page, an old cached page or a hand-made request cannot change a price, add a field or redirect a success action.

**The editor itself.** The canvas is an iframe whose document gets a `Content-Security-Policy` meta tag before any content: `default-src 'none'; script-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'` plus images, media, styles and fonts from `https:` only. Whatever a page contains, no script of it runs in the editor, and the project is passed through `cleanProject` before it is loaded. Inline text editing changes text nodes through the browser's editing commands; link addresses typed in the Link dialog are restricted to `http(s)`, `mailto:`, `tel:`, `/path` and `#anchor`, and the editor refuses to save a project the server would reject (it shows the reason: for example "Invalid or unsafe URL").

**Previews and thumbnails.** The signed preview is served from the app's own origin, so it carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox` (no `allow-same-origin`): the page gets an opaque origin and can neither read the admin app's storage nor call its API with the user's token. Thumbnails, template previews and the version-history preview are `<iframe sandbox="">` with the page's scripts and embedded players removed before they are shown.

**Uploaded images** (`/api/assets`): the type is decided by magic bytes (PNG, JPEG, GIF, WebP; SVG and everything else is refused, whatever the file name or `Content-Type` says), at most 1.5 MB each and 200 per workspace; files are stored in the database and served from `/uploads/:id/:name` with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Cache-Control: public, max-age=31536000, immutable` (the URL is content-addressed by id).

**Tested.** `pagemodel.xss.test.ts` (49 tests: about 40 OWASP-style payloads, each pushed through every attacker-controlled entry point (text, attributes, typed props, custom code, style rules, link and image URLs) with the rendered page parsed by jsdom for anything executable, plus focused tests for CSS filtering, structure cleaning, idempotence and the custom-code permission rule), `pagemodel.limits.test.ts`, `pagemodel.api.test.ts` (save, derive, permission rule, concurrency, restore), `assets.test.ts`; in a real browser: [builder.spec.ts](../e2e/tests/builder.spec.ts) ("publish: unsafe input is refused or stays text") checks the published page of a saved project against the editor and for editor chrome and handlers. Counts are in [TESTING.md](TESTING.md). **Residual risks**: published pages still have no CSP (customers add tracking snippets), so an owner-authored script runs with full rights on the customer's own domain by design; the CSS and HTML filters are allow-lists we maintain, so a new browser feature is blocked until added, and a mistake in an allow-list entry is the failure mode to watch (the corpus is where to add a case); the e2e suite runs on Chromium only.

## Ads: consent, hashing and tokens

* **Consent.** The pixel runtime can require opt-in per scope, with a region rule, Do Not Track / Global Privacy Control, and Google Consent Mode v2 signals ([ADS.md](ADS.md#consent)). With consent required nothing is loaded and nothing is sent to a network before *Accept*. The visitor's state is reported to the server with the attribution record, and **server-side conversions obey it**: a banner in use needs `granted`; otherwise an explicit `denied` (including Do Not Track) blocks, and the blocked delivery is logged as `skipped`. Click ids and browser ids are not sent to the server unless consent is not `denied`/`unknown`. The region rule is a time-zone heuristic, not legal advice: configure what your counsel requires.
* **PII hashing.** Email, phone, names, postal code, country, city, state and the visitor id are normalised per network and SHA-256 hashed *when the event happens* ([ADS.md](ADS.md#server-side-conversions)); the stored request has hashes only, so neither the database nor the delivery log holds a raw email or phone for this purpose. IP address and user agent are sent unhashed because the networks require it, are kept on the visitor record for `ATTRIBUTION_RETENTION_DAYS`, and are nulled by the maintenance job afterwards. Hashing is not anonymisation: a SHA-256 of an email is still personal data under GDPR (it can be matched by anyone who has the email).
* **Tokens.** Access tokens and API secrets are encrypted at rest with `DATA_ENCRYPTION_KEY` (AES-256-GCM; production refuses to store them without it), returned masked, redacted from error texts and logs (a test feeds tokens through every error path), and every integration change is in the audit log (without the token). The GA4 secret must travel in a query string (Google offers no header); Meta's token goes in the request body, TikTok's in a header. Outbound calls use the SSRF-guarded fetch (public hosts only, no redirects, timeout).
* **Published pages on Cloudflare Pages** get a per-page Content-Security-Policy ([CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md#what-gets-built)): exact for the platform's own scripts, relaxed to `'unsafe-inline' https:` only for pages that contain owner-authored code.

## Commerce: catalog, templates, summaries

- **Price authority.** A checkout never reads an amount from the page or the request: the catalog price is resolved server-side at checkout and refreshed on every save; ids a client sends are looked up with the workspace id, so another tenant's product cannot be linked ([PRODUCTS.md](PRODUCTS.md)).
- **Templates** carry no workspace ids; imports (platform administrators only) pass the page-save sanitiser without script rights and are size limited. SVG is not accepted anywhere in pages; template art is CSS.
- **AI summary.** Product, funnel and step names are untrusted text: cleaned, delimited as data, and every number the model writes must exist in the SQL evidence or the answer is replaced ([ADR 0025](adr/0025-grounded-analytics-summary.md)); links and markup are refused. The CSV export neutralises spreadsheet formulas.
- Stripe catalog sync uses the connected account id stored per product and price; a different account resets the ids, and webhook reconciliation only touches objects of the event's own account.

## AI builder and Google reviews

* The AI brief and the page text sent to the assistant are untrusted data (delimited, brackets defused, injection flagged); model output is plain text or schema-validated operations, never HTML, and passes the page cleaner and sanitiser ([AI-BUILDER.md](AI-BUILDER.md)). Generated copy may not carry invented facts (claims guard), prompts never contain keys or tenant ids, and the PII redaction option keeps personal data out of the stored prompt. Generation records hold the prompt for `AI_GENERATION_RETENTION_DAYS`.
* Google Places keys are encrypted (AES-256-GCM, `DATA_ENCRYPTION_KEY`), shown only as the last four characters, sent in a header, never logged or audited; calls use the SSRF-guarded fetch. Review content is third-party personal data (names, photos, text): it is cached for a short documented time, rendered escaped (text nodes in the browser runtime), links and avatars accepted only from Google hosts, and `/public/reviews/:token` returns only public place data for the block's own workspace ([REVIEWS.md](REVIEWS.md)).

## Authentication and authorisation

Email and password (scrypt, per-user salt), optional TOTP two-factor authentication, sessions with rotating refresh tokens, invitations and password reset by one-time links (hashes stored), JWT access tokens (`jose`, HS256). Authorization is permission-based: `server/src/routes/spec.ts` declares one permission per route, `authenticate()` enforces it, and a generated test matrix proves every route refuses a role without exactly that permission ([RBAC.md](RBAC.md)). An audit log records the security-relevant actions. Platform administrators are rows in `platform_admins` (bootstrapped from `PLATFORM_ADMIN_EMAILS`), separate from workspace roles, checked centrally with mandatory two-factor in production; support access (impersonation) is read-only by default, reasoned, time-limited, audited in the customer's own log and cannot touch credentials, billing, members or API keys; writes need an explicit `allow_writes` session that only a `superadmin` platform role can open, with a written reason, a shorter lifetime and an audit entry per change ([ADMIN.md](ADMIN.md)).

## Network and transport

TLS is terminated in front (Cloudflare, a load balancer). Set `TRUST_PROXY` and `TRUSTED_PROXY_HOPS` to match, restrict `/internal/*` to the Worker (WAF rule in docs/CLOUDFLARE.md), keep `/metrics` private or protected with `METRICS_TOKEN`. Security headers: `nosniff`, `referrer-policy`, CSP on the SPA shell; published pages intentionally have no CSP (customers add tracking snippets).

## Dependencies

`npm audit --omit=dev` runs in CI for the server, web and edge. Dev-only tooling (vitest, tsx, mermaid, fast-check, pglite) is not shipped.

## Payments

Card data never reaches Funnels (Stripe-hosted Checkout). Stripe webhooks are verified (HMAC-SHA256, timestamp tolerance, constant-time compare, separate secrets for the platform and Connect endpoints) before any state changes, events are deduped by id, and prices are always taken from stored blocks, never from the request. Refund amounts are reserved in a transaction before Stripe is called. See [STRIPE.md](STRIPE.md); the integration is unverified against real Stripe.
