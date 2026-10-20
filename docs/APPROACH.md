# Approach

## What was built and why this way

The legacy product is a multi-tenant SaaS where funnels are GrapesJS pages stored as raw HTML in Mongo, served by a Cloudflare worker, with domains, Stripe, CRM and forms living in other modules. This rebuild keeps the product and replaces every cross-product dependency with a small, owned equivalent.

| Concern | Legacy | Here |
|---|---|---|
| Storage | Mongo, transactions, change streams | `node:sqlite`, WAL, hand-written repositories, SQL migrations applied at boot |
| Page model | GrapesJS project JSON + client HTML (trusted) | GrapesJS project JSON (versioned, cleaned by allow-lists and zod on the server) is the source of truth; the server renders and sanitises the HTML, the client never sends it ([ADR 0022](adr/0022-grapesjs-page-builder.md)) |
| Serving | Edge worker + signed endpoint (HMAC skipped without secret) | Same server resolves `Host` + path; previews need a signed short-lived token |
| Domains | Cloudflare custom hostnames | Domain registry, DNS TXT + CNAME verification through an injectable resolver |
| Analytics | One overloaded collection | `events` table with `page_view | optin | order` |
| Jobs | BullMQ, cron, change streams | sqlite `jobs` table, polled in-process worker |
| Thumbnails | Puppeteer | The stored page itself in a sandboxed, script-free iframe scaled into the card (a gradient from the first heading while it loads) |
| Payments | Stripe Connect widget | `PaymentProvider` interface with a mock |

## Decisions (made autonomously)

* **npm, two packages**, root scripts delegate. `web` imports `server/src/pagemodel/shared` through the `@pagemodel` alias so the editor canvas and the publisher use one set of rules for what a page may contain and how its dynamic parts are rendered.
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
* **Custom scripts**: the *Custom code* block (and with it any script) exists only for a saver who is the owner of a workspace with `allowCustomScripts` on (`step_pages.scripts_ok`). Header/footer tracking code is published only with the flag on and can only be written by admins. For everybody else the server removes script, event handlers and unsafe CSS from the stored project itself (a non-permitted saver cannot add or change a code block; one saved earlier by the owner is kept untouched).
* **The server owns prices, fields and success URLs.** `forms` and `products` are derived on every save from typed component props and are what the public form and checkout endpoints read; the browser never sends them.
* **A page document is limited**, not just validated: 3,000 components, depth 24, 6,000 CSS rules, 2 MB (`413 DOCUMENT_TOO_LARGE`), 1.5 MB for a legacy block document.
* **Autosave sends `backup: false`**, so it does not consume the 10 history slots. Optimistic concurrency uses the step `version`; a stale save is a 409 `VERSION_CONFLICT`.
* **Soft delete detaches the domain** (freeing its paths); restore returns the funnel in test mode; purge is owner-only and trash-only and cascades to analytics.
* **Idempotency**: form `submissionId`, checkout `submissionId`, and `externalId` on opt-in events are unique per funnel.
* **Domain verification needs both** the TXT token (ownership) and the CNAME (routing).

## Security notes

* zod validation on every input; body size limits (2 MB API, 8 KB events, 64 KB forms/checkout, 256 KB AI).
* Output escaping in the renderer; allow-list rebuild of every project node, `sanitize-html` over the rendered body, `postcss` over free-form CSS; URL scheme allow-lists; video host allow-list. Previews are served with `Content-Security-Policy: sandbox ...` (opaque origin). Layers and tests: [SECURITY.md](SECURITY.md#page-builder-and-published-pages).
* Cross-tenant access is 404 and tested for every resource type; roles are re-read from the database on each request.
* scrypt password hashing, HS256 JWTs with a `use` claim (access / preview / SSE ticket), 12h default TTL.
* Rate limits: auth, public events, forms, checkout, AI (per workspace plus a daily cap).
* Webhooks: HMAC-SHA256 over `timestamp.body`, SSRF protection (blocked ranges, DNS resolved and pinned, redirects not followed, credentials in URLs refused).
* CSV exports neutralise formula injection.
* CSP only on the SPA shell; published pages intentionally have none (customers add tracking snippets).
* No secrets in the repo; `.env.example` is blank.

## Intentionally left out

Live chat widget, split testing, share-link shortener, a media gallery beyond the image library (uploads are small rasters stored in the database, no S3), Stripe (only the interface), email delivery of invitations, subaccounts/white-label, async template clone pipeline (cloning is one transaction). See MIGRATION-NOTES.md.

## Known limitations

Single-node by default (in-memory limiter, cache and SSE bus; SQLite is one writer). PostgreSQL removes the database limit, not the in-memory ones. The builder is exercised in a real browser (Playwright, real mouse drags, see [TESTING.md](TESTING.md)) on Chromium only; Firefox and Safari have not been tried. Pointer drags of blocks into the canvas use GrapesJS's HTML5 drag and drop, which touch screens do not fire: on a phone or tablet use click-to-insert and the Layers panel.

## Phase 3 decision record: async data layer and PostgreSQL

* **Context.** Every service called synchronous `node:sqlite` directly, which blocks any server database, multiple replicas, and the later Redis/BullMQ, Stripe and admin work.
* **Decision.** One small async `Db` interface (query/get/all/run, `transaction`, savepoints, `explain`) with three drivers: `SqliteDb` (zero-config default), `PgDb` (`pg` Pool, production) and `PgliteDb` (tests). `DATABASE_URL=postgres://` selects PostgreSQL. SQL stays hand-written (no ORM) with `?` placeholders; dialect differences are named in `db/dialect.ts`. Per-dialect migration directories with shared numbering, checked by an introspection test.
* **Alternatives rejected.** An ORM or query builder (a large dependency and a rewrite of every query, for a codebase this size); keeping SQLite sync and adding Postgres beside it (two code paths in every service); `AsyncLocalStorage` for an ambient transaction (hides which handle a statement uses, and makes the SQLite single-connection rule impossible to see in code); `citext`/`COLLATE NOCASE` (not portable, the app already stores `name_lower`); database-generated ids (rows would stop being portable).
* **Consequences.** Services take `deps` and use `deps.db`; inside `inTx` they receive a scoped copy. Writes that must be atomic across concurrent requests rely on row locks in a fixed order, not on JavaScript being single-threaded any more. PGlite is single-connection, so a real Postgres job is part of CI. SQLite triggers are gone: rollups are maintained by the application in the same transaction (docs/PERFORMANCE.md has the numbers). Per-process state (limiter, cache, SSE, buffer sets) is unchanged and still needs Redis before a second replica is safe.

## Phase 2 decisions

* Analytics reads use 15-minute rollups (maintained by the application since phase 3); funnel-level distinct visitors scan raw events.
* Event ingestion is write-behind (flush 250 ms or 5,000 rows, on shutdown, and before any read). `EVENT_BUFFER_MS=0` disables it.
* Worker threads and Web Workers were measured and not adopted (docs/PERFORMANCE.md).
* The edge worker is optional; the origin serves pages without it. Edge calls are signed and fail closed.
* **Not done** from the phase 2 brief: Redis (cache, limiter, pub/sub, BullMQ), k6 scenarios, OpenTelemetry, workerd-based worker tests, HPA in the active kustomization (single-replica by design, `deploy/k8s/optional/hpa.yaml` is provided), a Docker/compose run (not verified here: docker was not used), web workers.
