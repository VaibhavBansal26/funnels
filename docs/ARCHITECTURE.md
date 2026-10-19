# Architecture

Funnels is one Node process (Hono + `node:sqlite`) that serves the JSON API, the built React app, published funnel pages (by `Host` header) and signed previews. A small in-process worker drains a SQLite-backed job queue.

## Context

```mermaid
flowchart LR
  Owner[Workspace member] -->|browser| App[Funnels app]
  Visitor[Visitor] -->|customer domain / beacon| App
  App -->|signed webhooks| Hooks[Customer endpoints]
  App -->|DNS TXT/CNAME lookups| DNS[(DNS)]
  App -.->|optional| LLM[Anthropic API]
  App -.->|future: PaymentProvider| Pay[Stripe Connect]
```

## Containers

```mermaid
flowchart TB
  subgraph Process[Node process]
    Router[Hono app]
    Host[hostRouting middleware]
    API[/api routers: auth funnels tags domains templates leads orders webhooks ai/]
    Pub[/api/public: events forms checkout/]
    Prev[/preview/:funnelId/]
    Svc[Services + repositories]
    Block[blocks: schema, sanitiser, renderer]
    Worker[JobWorker poll loop]
    Bus[EventBus -> SSE]
    Cache[PageCache LRU]
  end
  DB[(SQLite WAL)]
  Web[web/dist React SPA]
  Router --> Host --> API & Pub & Prev
  API --> Svc --> DB
  Svc --> Block
  Worker --> DB
  Worker --> Hooks2[Webhook delivery, domain re-verify]
  Svc --> Bus
  Host --> Cache --> DB
  Router --> Web
```

* `server/src/blocks` is pure TypeScript (only `zod` imported). The server renders with it and the web builder imports the very same files through a Vite alias, so the canvas is the same renderer that publishes.
* Everything with side effects is injected through `Deps` (`DnsResolver`, `PaymentProvider`, `HttpClient`, `AiProvider`, clock, rate limiter, job queue). Tests swap fakes in.

## Data model

```mermaid
erDiagram
  workspaces ||--o{ users : has
  workspaces ||--o{ funnels : owns
  workspaces ||--o{ domains : registers
  workspaces ||--o{ tags : defines
  funnels ||--|{ steps : contains
  steps ||--|| step_pages : "doc_json + html + checksum"
  steps ||--o{ step_backups : "newest 10"
  funnels }o--o{ tags : funnel_tags
  funnels }o--o| domains : "attached (active only)"
  funnels ||--o{ events : "page_view|optin|order"
  funnels ||--o{ orders : records
  workspaces ||--o{ leads : "unique email"
  workspaces ||--o{ webhooks : has
  webhooks ||--o{ webhook_deliveries : logs
  templates ||--|{ template_steps : seeds
  template_categories ||--o{ templates : groups
```

Every business table has `workspace_id`; repositories and services always filter by it. `templates`, `template_steps` and `template_categories` are global, workspace-less tables. `jobs`, `notifications`, `ai_usage` back the queue, the feed and the daily AI cap.

## Key flows

### Save a page

```mermaid
sequenceDiagram
  participant UI as Builder
  participant API as PUT /steps/:id/page
  participant DB as SQLite
  UI->>API: { doc, version, backup }
  API->>API: zod-validate doc (limits, depth, ids)
  API->>DB: BEGIN
  API->>DB: insert step_backups (previous doc/html)
  API->>API: renderPage(doc, ctx) -> html, checksum
  API->>DB: update step_pages, bump steps.version
  API->>DB: prune backups to newest 10
  API->>DB: COMMIT
  API->>API: pageCache.invalidate(step)
  API-->>UI: { version, checksum }
```

### Serve a live page

```mermaid
sequenceDiagram
  participant V as Visitor
  participant H as hostRouting
  participant DB
  V->>H: GET offers.example.com/promo
  H->>DB: domain by hostname (active?)
  H->>DB: step where funnel live, path_key match
  alt cached
    H->>H: PageCache hit
  end
  H-->>V: 200 html, ETag=checksum, Set-Cookie visitor_id/funnel_id/step_id/utm_*
  V->>H: POST /api/public/events (beacon, sendBeacon)
```

### Form submit to webhook

```mermaid
sequenceDiagram
  participant B as beacon.js
  participant P as /api/public/forms
  participant DB
  participant W as JobWorker
  participant C as Customer endpoint
  B->>P: fields, submissionId
  P->>DB: tx: upsert lead (email), optin event, notification, delivery + job
  P-->>B: ok -> success action
  W->>DB: claim due job
  W->>C: POST signed body (pinned vetted IP, no redirects)
  alt non-2xx
    W->>DB: requeue, 30s * 2^n backoff, dead after max attempts
  end
```

## Domain state machine

```mermaid
stateDiagram-v2
  [*] --> pending: add hostname
  pending --> active: TXT token + CNAME match
  pending --> failed: not verified within 72h
  active --> failed: DNS lost on re-verify
  failed --> active: DNS fixed, verify
  active --> [*]: delete
  note right of failed: funnels on the domain -> test + detached, same transaction
```

Funnel rules: `live` needs an attached **active** domain; `status: test` detaches the domain; attaching runs the cross-funnel path conflict check and accepts a resolution payload that must be a subset of the server's own conflicts.

## Deployment

```mermaid
flowchart LR
  DNS[Customer DNS CNAME -> APP_PUBLIC_CNAME_TARGET] --> LB[TLS terminating proxy / CDN]
  LB --> C[Container: node server/dist/index.js]
  C --- V[(volume /data funnels.db)]
```

One container, one volume. TLS for customer domains is terminated in front (Caddy on-demand TLS, a CDN, or Cloudflare for SaaS). Scaling beyond one node needs a shared database and rate limiter; see APPROACH.md.

## Scaling and limits

SQLite in WAL mode with a single writer is the deliberate single-node choice. Rate limiting, the page cache and the SSE bus are in memory, per process. Analytics scan the `events` table (indexed by funnel and time); rollups would be the first optimisation at volume.

## Edge and performance layer

```mermaid
flowchart LR
  V[Visitor] --> W[Cloudflare Worker: cache, SWR, cookies]
  W -->|HMAC-signed /internal/edge/resolve| O[Hono app]
  O -->|edge.purge job| P[CloudflarePurger]
  O --> B[EventBuffer: write-behind] --> E[(events)] -->|trigger| R[(event_rollups 15 min)]
  A[Analytics API] --> R
```

See docs/CLOUDFLARE.md and docs/PERFORMANCE.md. Domains can be managed by a `DomainProvider` (`manual` DNS checks by default, `cloudflare` for Cloudflare for SaaS). `/metrics` (Prometheus), `/readyz`, request timeouts and gzip are in `app.ts`.
