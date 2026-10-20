# Configuration

Generated from the zod schema in `server/src/config.ts` and the descriptions in `server/src/config.docs.ts` by `npm run docs:config`; `npm test` fails when this file is stale. Configuration is environment-only and validated at boot (the process refuses to start with an invalid value). Nothing is required in development. Copy `.env.example` for a starting point.

| Variable | Default | Required | Example | What it does |
|---|---|---|---|---|
| `NODE_ENV` | `development` | no | `production` | Runtime mode. `production` makes JWT_SECRET mandatory. |
| `PORT` | `3000` | no | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | no | `0.0.0.0` | Interface to bind. |
| `DATABASE_URL` | (unset) | no | `postgres://funnels:secret@db:5432/funnels` | PostgreSQL connection URL. When set it selects PostgreSQL (a `pg` pool) and DATABASE_PATH is ignored. Unset = SQLite. **Security:** Contains credentials: pass it as a secret, never commit it. Use TLS (`?sslmode=require`) outside a private network. |
| `DATABASE_POOL_MAX` | `10` | no | `10` | Maximum connections in the PostgreSQL pool per process. Size it so `replicas x pool` stays below the server (or PgBouncer) limit. |
| `DATABASE_REPLICA_URLS` | (empty) | no | `postgres://funnels:secret@replica-1:5432/funnels` | Comma-separated PostgreSQL read replica URLs. History, lists, exports and analytics read through `db.read()`, which uses a healthy replica round-robin and falls back to the primary. **Security:** Credentials, like DATABASE_URL. Replicas must be read-only. |
| `REPLICA_MAX_LAG_MS` | `2000` | no | `2000` | A replica more than this many milliseconds behind is taken out of rotation until it catches up. |
| `REPLICA_STICKY_MS` | `5000` | no | `5000` | After a write by a workspace, its reads go to the primary for this long (read-your-writes). |
| `DATABASE_PREPARED_STATEMENTS` | `true` | no | `true` | Use named server-side prepared statements on PostgreSQL. Set `false` behind PgBouncer in transaction pooling mode (connections are shared between clients, so a statement prepared on one is unknown on the next). |
| `REDIS_URL` | (unset) | no | `redis://redis:6379` | Redis for the shared rate limiter. Unset = per-process in-memory limiter (fine for one replica). **Security:** May contain a password. Use `rediss://` over untrusted networks. |
| `REDIS_KEY_PREFIX` | `funnels` | no | `funnels-prod` | Namespace for every Redis key, so deployments can share one Redis. |
| `REDIS_TIMEOUT_MS` | `25` | no | `25` | Budget for one limiter call to Redis. Past it the call counts as a failure and the policy fails open or closed (docs/RATE-LIMITING.md). |
| `DATABASE_PATH` | `./data/funnels.db` | no | `/data/funnels.db` | SQLite file used when DATABASE_URL is unset (`:memory:` for tests). |
| `JWT_SECRET` | (generated in development) | in production | `(32+ random characters)` | HMAC secret for access, preview and stream tokens (32+ characters). Generated and logged as a warning when unset outside production, so sessions then do not survive a restart. **Security:** Rotating it logs everybody out. Never commit it; a leaked secret allows forging any user token. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | no | `900` | Lifetime of access tokens (short: the web app renews them with the refresh token, and revoking a session ends its access tokens at once). |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | no | `30` | Lifetime of a refresh token before it must be used (each use issues a new one, so an active session never hits this). |
| `SESSION_MAX_DAYS` | `90` | no | `90` | Absolute lifetime of a session regardless of activity; after it the user signs in again. |
| `REFRESH_REUSE_GRACE_SECONDS` | `10` | no | `10` | A refresh token presented again within this many seconds of its first use is treated as two tabs racing (401 REFRESH_RACE, session kept); later reuse revokes the whole session. |
| `INVITATION_TTL_DAYS` | `7` | no | `7` | How long an invitation link stays valid. |
| `PASSWORD_RESET_TTL_MINUTES` | `60` | no | `60` | How long a password reset link stays valid. |
| `TOTP_ISSUER` | `Funnels` | no | `Funnels` | Name shown in authenticator apps next to the account. |
| `DATA_ENCRYPTION_KEY` | (unset) | no | `a-long-random-string-of-at-least-32-chars` | Key (min 32 chars) for encrypting TOTP secrets at rest (AES-256-GCM). Falls back to a key derived from JWT_SECRET; set it separately so rotating JWT_SECRET does not lock everyone out of 2FA. **Security:** Secret. Losing it makes enrolled TOTP secrets unreadable (users must re-enrol); rotating needs a re-encryption step that is not automated. |
| `MAIL_TRANSPORT` | `none` | no | `webhook` | How invitations and password resets are sent: `none` (nothing is sent; invitation links are shown to the inviter, resets cannot be delivered), `console` (printed to the log, development only), `webhook` (POST JSON to MAIL_WEBHOOK_URL). |
| `MAIL_FROM` | `Funnels <no-reply@localhost>` | no | `Funnels <no-reply@example.com>` | Sender passed to the mail transport. |
| `MAIL_WEBHOOK_URL` | (unset) | no | `https://mail-bridge.internal/send` | Endpoint that receives `{from,to,subject,text}` and hands it to your mail provider. |
| `MAIL_WEBHOOK_SECRET` | (unset) | no | `a-long-random-string` | When set, each mail webhook carries `X-Signature: sha256=<HMAC-SHA256 of the body>` (min 16 chars). **Security:** Secret. |
| `PREVIEW_TOKEN_TTL_SECONDS` | `900` | no | `900` | Lifetime of signed preview links. |
| `APP_PUBLIC_URL` | `http://localhost:3000` | no | `https://app.example.com` | Public base URL of the app; its host is reserved and cannot be registered as a customer domain. |
| `APP_PUBLIC_CNAME_TARGET` | `sites.funnels.example` | no | `sites.example.com` | Hostname customers point their CNAME at. |
| `CORS_ORIGINS` | (empty) | no | `https://app.example.com` | Comma-separated origins allowed to call /api cross-origin. |
| `PLATFORM_ADMIN_EMAILS` | (empty) | no | `ops@example.com` | Comma-separated emails of platform administrators (global templates, rate limit operations). **Security:** Matched case-insensitively against the account email; protect those mailboxes. |
| `TRUST_PROXY` | `false` | no | `true` | Believe X-Forwarded-For (see TRUSTED_PROXY_HOPS). Turn on only behind a proxy you control; otherwise clients can forge their address and dodge per-IP limits. **Security:** Misconfiguring it either way breaks per-IP limits: off behind a proxy throttles everyone as one client, on without a proxy lets clients choose their IP. |
| `WEB_DIST` | `../web/dist` | no |  | Directory of the built web app to serve. Defaults to ../web/dist relative to the server. |
| `ANTHROPIC_API_KEY` | (unset) | no |  | Enables the Anthropic provider for AI features. Unset = offline heuristic provider. **Security:** Secret. Prompts never contain it. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | no |  | Model used by the Anthropic provider. |
| `AI_DAILY_CAP` | `50` | no | `50` | AI calls per workspace per UTC day (0 disables AI). Enforced by the `ai.daily` sliding-window policy (shared across replicas with REDIS_URL, scaled by plan tier); `ai_usage` meters. |
| `INGEST_WORKSPACE_PER_MINUTE` | `600000` | no | `600000` | Public events one workspace may send per minute (policy `ingest.workspace`, free plan; pro x5, business x20, overridable per workspace). Beyond it that workspace gets 429 with Retry-After while every other workspace is unaffected. The default (10,000/s) is a noisy-neighbour guard, not a billing limit. |
| `AI_RATE_LIMIT_PER_MINUTE` | `10` | no | `10` | AI calls per workspace per minute (policy `ai.minute`, each call costs 10 units). |
| `RATELIMIT_ENABLED` | `true` | no | `true` | Master switch for the rate limiter. `false` admits everything (emergency use, benchmarks). **Security:** Disabling removes flood and credential-stuffing protection. |
| `RATELIMIT_LEASE_FRACTION` | `0.1` | no | `0.1` | Fraction of a token bucket a process pre-pays from Redis and spends locally (0 disables the local tier; max 0.5). Error bound in docs/RATE-LIMITING.md. |
| `IP_GUARD_PER_MINUTE` | `1200` | no | `1200` | Policy `ip.global`: requests per client IP per minute across the whole app (burst = a quarter). |
| `PUBLIC_PAGES_PER_MINUTE` | `6000` | no | `6000` | Policy `public.page`: pages served directly by the origin on customer domains, per IP per minute. |
| `API_USER_PER_MINUTE` | `600` | no | `600` | Policy `api.read`: authenticated requests per user per minute (writes get half). |
| `API_WORKSPACE_PER_MINUTE` | `600` | no | `600` | Policy `api.workspace`: requests per workspace per minute on the free plan (pro x5, business x20). |
| `EXPORT_CONCURRENCY` | `2` | no | `2` | Policy `api.export`: concurrent CSV exports per workspace on the free plan (pro x2, business x4). |
| `EDGE_RESOLVE_PER_MINUTE` | `120000` | no | `120000` | Policy `edge.resolve`: signed worker calls per minute (all arrive from few addresses). |
| `TRUSTED_PROXY_HOPS` | `1` | no | `1` | Reverse proxies that append to X-Forwarded-For; the client address is that many entries from the right. |
| `TRUST_CLOUDFLARE_RANGES` | `true` | no | `true` | Believe CF-Connecting-IP when the TCP peer is inside Cloudflare's published ranges. |
| `CF_IP_RANGES` | (empty) | no | `173.245.48.0/20,103.21.244.0/22` | Comma-separated CIDRs replacing the built-in Cloudflare range list. |
| `PUBLIC_EVENTS_PER_MINUTE` | `120` | no | `120` | Policy `public.events`: beacon events per IP and funnel per minute. |
| `PUBLIC_FORMS_PER_MINUTE` | `20` | no | `20` | Policies `public.forms` and `public.checkout`: posts per IP and funnel per minute. |
| `AUTH_ATTEMPTS_PER_MINUTE` | `10` | no | `10` | Policy `auth.attempts`: register and login requests per IP per minute. |
| `WEBHOOK_MAX_ATTEMPTS` | `6` | no | `6` | Delivery attempts before a webhook delivery is dead-lettered (30 s x 2^n backoff). |
| `DOMAIN_VERIFY_TIMEOUT_HOURS` | `72` | no | `72` | Hours a pending domain keeps being re-checked before it is marked failed. |
| `ANALYTICS_DISTINCT_MODE` | `auto` | no | `auto` | Funnel-level distinct visitors: `auto` (exact scan for small ranges, HyperLogLog sketches above ANALYTICS_EXACT_DISTINCT_MAX page views), `exact` (always scan) or `sketch` (always sketches, for tests and very large funnels). |
| `ANALYTICS_EXACT_DISTINCT_MAX` | `200000` | no | `200000` | Page views in a range above which `auto` switches to sketches (1.6% standard error). The response says which method was used. |
| `PAYMENTS_PROVIDER` | `mock` | no | `stripe` | `mock` (default: no real payment, orders are recorded as if paid; development and demos only) or `stripe` (hosted Stripe Checkout on the workspace's connected account). UNVERIFIED against the real Stripe API in this repository, see docs/STRIPE.md. **Security:** With `mock` in production every checkout "succeeds" without payment: set `stripe` before taking real orders. |
| `STRIPE_SECRET_KEY` | (unset) | no | `sk_test_51...` | The platform Stripe secret key (sk_test_... or sk_live_...). Needed for PAYMENTS_PROVIDER=stripe and for subscriptions. **Security:** Secret. Restricted keys work if they allow Connect accounts and account links, Checkout sessions, PaymentIntents, Refunds, Customers, Billing portal. |
| `STRIPE_WEBHOOK_SECRET` | (unset) | no | `whsec_...` | Signing secret of the platform webhook endpoint `POST /api/stripe/webhook` (whsec_...): subscriptions and invoices. **Security:** Secret. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | (unset) | no | `whsec_...` | Signing secret of the Connect webhook endpoint `POST /api/stripe/connect-webhook` (events on connected accounts: checkout, refunds, account updates). A different endpoint has a different secret. **Security:** Secret. |
| `STRIPE_API_BASE` | `https://api.stripe.com` | no | `https://api.stripe.com` | Stripe API base URL; change only for a test double. |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | `300` | no | `300` | How old a webhook signature timestamp may be before it is refused as a replay. |
| `STRIPE_PRICE_PRO` | (unset) | no | `price_1Abc` | Stripe Price id (price_...) of the Pro subscription. |
| `STRIPE_PRICE_BUSINESS` | (unset) | no | `price_1Def` | Stripe Price id (price_...) of the Business subscription. |
| `BILLING_ENFORCE_LIMITS` | `false` | no | `false` | Enforce plan limits (funnels, domains, members, API keys per plan, see docs/STRIPE.md). Off by default: a self-hosted install without billing has no limits. |
| `MAX_CUSTOM_ROLES` | `50` | no | `50` | Most custom roles one workspace may define. |
| `ANALYTICS_API_PER_MINUTE` | `60` | no | `60` | Requests per minute per API key on the analytics API (policy `analytics.read`; the workspace as a whole has its own, plan-tiered budget, `analytics.workspace`). |
| `ANALYTICS_EXPORT_PER_MINUTE` | `10` | no | `10` | Export requests per minute per API key (policy `analytics.export`). Each request returns one page of up to 20,000 lines. |
| `ANALYTICS_READ_STORE` | `postgres` | no | `postgres` | Where analytics reads come from: `postgres` (the primary database, authoritative, default) or `clickhouse` (the mirror; needs CLICKHOUSE_URL and EVENTSTORE_MIRROR=clickhouse so it has data). UNVERIFIED against a real ClickHouse server in this repository, see docs/SCALING.md. The mirror is eventually consistent, so reads fall back to the primary when it is stale or failing. |
| `ANALYTICS_CLICKHOUSE_MAX_LAG_S` | `60` | no | `60` | ClickHouse reads are used only while the oldest unpublished outbox row is younger than this many seconds; beyond it the primary answers (the numbers would otherwise silently lag). |
| `ANALYTICS_CLICKHOUSE_FALLBACK` | `true` | no | `true` | When a ClickHouse read fails, answer from the primary instead (and count it in `funnels_analytics_reads_total{source="fallback"}`). With false the request fails with 503 ANALYTICS_STORE_UNAVAILABLE. |
| `EVENT_DEDUPE_DAYS` | `30` | no | `30` | How long opt-in and order idempotency keys are remembered (`event_dedupe`); a retry with the same key after this window is a new event. |
| `PARTITION_MONTHS_AHEAD` | `3` | no | `3` | PostgreSQL: monthly partitions of `events` created ahead of time by the maintenance job. |
| `MAINTENANCE_INTERVAL_HOURS` | `6` | no | `6` | Interval of the maintenance job (partition creation, idempotency key pruning). |
| `EVENT_BUFFER_MS` | `250` | no | `250` | Write-behind flush interval for analytics events (0 = write-through). A hard kill can lose this window. |
| `EVENT_BUFFER_MAX` | `5000` | no | `5000` | Rows that force an early flush (backpressure for the caller). |
| `EVENT_REF_CACHE_SECONDS` | `5` | no | `5` | How long the events endpoint remembers that a (funnel, step) exists, so a beacon costs no database read (0 = look it up every time). Trashing, purging or deleting a step clears it on that process; other replicas may accept events for a just-trashed funnel for up to this long. |
| `EVENT_BUS` | `auto` | no | `auto` | Durable event bus for the ingest queue and the outbox relay: `redis` (Redis Streams, needs REDIS_URL), `memory` (one process, not durable) or `auto` (redis when REDIS_URL is set, else memory). |
| `EVENT_BUS_PARTITIONS` | `16` | no | `16` | Partition streams per topic. Events with the same key (funnel id) go to the same partition and are consumed in order; consumers of a group split the partitions. Changing it reshuffles keys: drain the topics first. |
| `INGEST_QUEUE` | `false` | no | `false` | Accept analytics events by publishing them to the event bus (`ingest.events`) and write them to the database from a consumer group in batches, instead of through the in-process buffer. Requires a durable bus in production (EVENT_BUS=redis). |
| `INGEST_MAX_LAG` | `2000000` | no | `2000000` | Backlog of the ingest consumer group above which the public events endpoint answers 503 `INGEST_BACKPRESSURE` (the beacon retries) instead of queueing more. |
| `OUTBOX_POLL_MS` | `200` | no | `200` | How often the outbox relay looks for unpublished rows. Every replica runs a relay; a PostgreSQL advisory lock lets one publish at a time. |
| `OUTBOX_DOMAIN_EVENTS` | `false` | no | `false` | Write `lead.created` and `order.created` to the transactional outbox (topic `funnels.domain`) in the same transaction as the lead or order. Off by default: nothing in this repository consumes the topic, it is the integration point for your own consumers (warehouse, CRM sync). |
| `EVENTSTORE_MIRROR` | `off` | no | `off` | Secondary event store: `clickhouse` copies every stored analytics event to ClickHouse through the outbox (idempotent by event id). PostgreSQL stays authoritative. |
| `CLICKHOUSE_URL` | (unset) | no | `http://clickhouse:8123` | ClickHouse HTTP interface, required when EVENTSTORE_MIRROR=clickhouse. |
| `CLICKHOUSE_DATABASE` | `funnels` | no | `funnels` | ClickHouse database holding the tables from deploy/clickhouse/schema.sql. |
| `CLICKHOUSE_USER` | (unset) | no | `funnels_writer` | ClickHouse user (sent as `X-ClickHouse-User`). |
| `CLICKHOUSE_PASSWORD` | (unset) | no |  | ClickHouse password. **Security:** Secret. Give the user INSERT on the events table only. |
| `REQUEST_TIMEOUT_MS` | `30000` | no | `30000` | A handler running longer gets a 504 (the client is released; synchronous work cannot be interrupted). |
| `EDGE_SHARED_SECRET` | (unset) | no | `(32+ random characters)` | Shared with the Cloudflare Worker to sign /internal/edge/resolve (32+ characters). Unset = the endpoint refuses everything (fail closed). **Security:** Secret. Rotate on both sides together. |
| `EDGE_SKEW_SECONDS` | `120` | no | `120` | Accepted clock skew of edge signatures; also the replay window. |
| `CF_ORIGIN_SECRET` | (unset) | no | `(16+ random characters)` | Header secret the Worker adds (`x-cf-origin-secret`) so the origin can trust CF-Connecting-IP. **Security:** Secret; anyone holding it can claim any client IP. |
| `CF_API_TOKEN` | (unset) | no |  | Cloudflare API token (cache purge; custom hostnames when DOMAIN_PROVIDER=cloudflare). **Security:** Secret; scope it to the zone with Cache Purge and SSL and Certificates edit only. |
| `CF_ZONE_ID` | (unset) | no |  | Cloudflare zone id used for purges and custom hostnames. |
| `CF_API_BASE` | `https://api.cloudflare.com/client/v4` | no | `https://api.cloudflare.com/client/v4` | Cloudflare API base URL (tests point it at a fake). |
| `DOMAIN_PROVIDER` | `manual` | no | `manual` | `manual` (DNS checks) or `cloudflare` (Cloudflare for SaaS custom hostnames). |
| `METRICS_TOKEN` | (unset) | no |  | Bearer token required to scrape /metrics. Empty = open. **Security:** Leave /metrics unreachable from the internet when empty. |
| `ENABLE_WORKER` | `true` | no | `true` | Run the in-process job worker (webhooks, domain checks, purges). With several replicas it is safe on all of them on PostgreSQL (`FOR UPDATE SKIP LOCKED`). |
| `JOB_POLL_MS` | `1000` | no | `1000` | Job queue poll interval. |
| `LOG_LEVEL` | `info` | no | `info` | debug, info, warn, error or silent. Logs are JSON lines. |

Booleans accept `1/true/yes/on` (case-insensitive); lists are comma-separated. Rate limit variables are explained in [RATE-LIMITING.md](RATE-LIMITING.md); database selection in [ARCHITECTURE.md](ARCHITECTURE.md#data-layer).
