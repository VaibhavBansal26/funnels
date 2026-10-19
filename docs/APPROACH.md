# Approach

## What was built and why this way

The legacy product is a multi-tenant SaaS where funnels are GrapesJS pages stored as raw HTML in Mongo, served by a Cloudflare worker, with domains, Stripe, CRM and forms living in other modules. This rebuild keeps the product and replaces every cross-product dependency with a small, owned equivalent.

| Concern | Legacy | Here |
|---|---|---|
| Storage | Mongo, transactions, change streams | `node:sqlite`, WAL, hand-written repositories, SQL migrations applied at boot |
| Page model | GrapesJS project JSON + HTML | Versioned, zod-validated block document; deterministic `renderPage` |
| Serving | Edge worker + signed endpoint (HMAC skipped without secret) | Same server resolves `Host` + path; previews need a signed short-lived token |
| Domains | Cloudflare custom hostnames | Domain registry, DNS TXT + CNAME verification through an injectable resolver |
| Analytics | One overloaded collection | `events` table with `page_view | optin | order` |
| Jobs | BullMQ, cron, change streams | sqlite `jobs` table, polled in-process worker |
| Thumbnails | Puppeteer | Gradient SVG from the first heading |
| Payments | Stripe Connect widget | `PaymentProvider` interface with a mock |

## Decisions (made autonomously)

* **npm, two packages**, root scripts delegate. `web` imports `server/src/blocks` through an alias so there is one renderer.
* **Users belong to one workspace** (`users.workspace_id`, `role`). Members are added by the owner with a one-time temporary password; there is no email delivery.
* **Money is integer cents**, one currency assumed per funnel when summing gross.
* **Funnel base path** is informational; the unit of path uniqueness is the step path. Comparison is case-insensitive and ignores a trailing slash (`steps.path_key`).
* **Path regex** is the legacy one plus rejection of control characters, whitespace, `?`, `#`, `\` (the legacy final-character class accepted them).
* **A funnel always keeps at least one step**; deleting the last step is a 409.
* **Reorder needs the complete set** of the funnel's steps; any positive distinct integers are accepted and normalised to 1..n.
* **`status: test` always detaches the domain.** Setting only `domain_id` attaches without publishing.
* **Browsers cannot report orders.** `POST /api/public/events` accepts `page_view` and `optin` only; orders come exclusively from the server-side checkout, so revenue cannot be forged.
* **Unique visits are computed server-side** from history, not trusted from the client. Funnel-level "unique" is distinct visitors; step-level counts first views per step.
* **Forms and checkout record nothing in preview** (client sends `preview: true`).
* **Custom scripts**: custom HTML keeps scripts only if the workspace flag `allowCustomScripts` is on AND the last save was made by the owner (`step_pages.scripts_ok`). Header/footer tracking code is published only with the flag on and can only be written by admins. Other users' edits strip scripts from the published HTML but never from the stored document.
* **Autosave sends `backup: false`**, so it does not consume the 10 history slots. Optimistic concurrency uses the step `version`; a stale save is a 409 `VERSION_CONFLICT`.
* **Soft delete detaches the domain** (freeing its paths); restore returns the funnel in test mode; purge is owner-only and trash-only and cascades to analytics.
* **Idempotency**: form `submissionId`, checkout `submissionId`, and `externalId` on opt-in events are unique per funnel.
* **Domain verification needs both** the TXT token (ownership) and the CNAME (routing).

## Security notes

* zod validation on every input; body size limits (2 MB API, 8 KB events, 64 KB forms/checkout, 256 KB AI).
* Output escaping in the renderer; allow-list sanitiser for custom HTML; URL scheme allow-lists; video host allow-list.
* Cross-tenant access is 404 and tested for every resource type; roles are re-read from the database on each request.
* scrypt password hashing, HS256 JWTs with a `use` claim (access / preview / SSE ticket), 12h default TTL.
* Rate limits: auth, public events, forms, checkout, AI (per workspace plus a daily cap).
* Webhooks: HMAC-SHA256 over `timestamp.body`, SSRF protection (blocked ranges, DNS resolved and pinned, redirects not followed, credentials in URLs refused).
* CSV exports neutralise formula injection.
* CSP only on the SPA shell; published pages intentionally have none (customers add tracking snippets).
* No secrets in the repo; `.env.example` is blank.

## Intentionally left out

Live chat widget, split testing, share-link shortener, media gallery/S3 uploads (images are URLs), Stripe (only the interface), email delivery of invitations, subaccounts/white-label, async template clone pipeline (cloning is one transaction). See MIGRATION-NOTES.md.

## Known limitations

Single-node by design (in-memory limiter, cache and SSE bus). The builder's click-to-select uses a script inside a sandboxed iframe and has only been exercised through unit tests and a production build here, not in a real browser session.
