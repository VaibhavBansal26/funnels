# Funnels

Build, publish and measure marketing funnels: a drag-and-drop page builder on [GrapesJS](https://grapesjs.com), templates, custom domains with DNS verification, public serving, analytics, leads and orders, signed webhooks and AI assistance. TypeScript, Hono, SQLite or PostgreSQL, React 19, Tailwind.

![The page builder](docs/design/builder-1440-light.webp)

More screens, light and dark, at three sizes: [docs/design/DESIGN.md](docs/design/DESIGN.md). Every page and control is described in the [user guide](docs/USER-GUIDE.md); how each feature works end to end in [docs/FEATURES.md](docs/FEATURES.md); the code map, data model and jobs in [docs/FUNCTIONS.md](docs/FUNCTIONS.md); the full documentation index is [docs/README.md](docs/README.md).

## Status

What is built, and how far it has been checked. "Fakes" means automated tests against an in-memory imitation of the service written from its documentation; see [docs/VERIFIED.md](docs/VERIFIED.md) for details.

| Area | Status |
|---|---|
| Accounts, roles and permissions, 2FA, invitations, audit log, admin panel | Built; tested (server on SQLite, PGlite and real PostgreSQL; browser tests) |
| Funnels, steps, page builder (GrapesJS), templates, products catalog, leads, analytics, webhooks, rate limiting, AI fallbacks (built-in writer) | Built; tested |
| Going live on the built-in address and on verified custom domains | Built; tested (DNS through an injected resolver) |
| Cloudflare Pages publishing, go live on `*.pages.dev` | Built; **verified on a real Cloudflare account** by the maintainer for connecting and going live; rollback, unpublish and Pages custom domains tested only against fakes |
| Cloudflare Workers static assets target | Built, experimental; tested only against fakes |
| Edge worker (`edge/`) | Built; unit-tested against fakes |
| Stripe Connect checkout, upsells, refunds, disputes, platform billing | Built; tested against fakes and **only sandbox response-shape checks**; no real payment has been made |
| Server-side conversions (Meta, GA4, TikTok), browser pixels | Built; tested only against fakes; **not verified with the networks** |
| Google reviews (Places API) | Built; tested only against fakes; **not verified with Google** |
| AI funnel builder and builder assistant with a real model (Anthropic) | Built; tested with a scripted fake model; **real model not verified** |
| Sentry error monitoring | Built, off by default; tested with the real SDK and a fake transport |
| ClickHouse analytics store | Built, optional; tested only against a fake |
| Ad campaign creation in ad platforms, SSO, passkeys, invoices for funnel checkouts, recording subscription renewals as orders | **Not built** |

## Run

Requires Node 22+ (developed on 24).

```bash
npm run install:all
npm run seed          # optional demo data: demo@example.test / demo-password-123
npm run dev           # API on :3000, Vite on :5173 (proxies /api)
```

Production-style:

```bash
npm run build && NODE_ENV=production JWT_SECRET=<32+ chars> npm start   # serves API + web on :3000
docker build -t funnels . && docker run -p 3000:3000 -v funnels-data:/data -e JWT_SECRET=... funnels
```

### Databases

Zero config uses SQLite (`node:sqlite`, file at `DATABASE_PATH`). Set `DATABASE_URL=postgres://user:pass@host:5432/db` and the same code runs on PostgreSQL (tested on 17 and 18) with a `pg` connection pool; migrations are applied at boot under an advisory lock, so several replicas can start together.

```bash
# PostgreSQL locally (needs Docker): app + postgres:17
JWT_SECRET=$(openssl rand -base64 48) docker compose up --build        # http://localhost:3000
# SQLite in Docker (single replica): docker compose --profile sqlite up --build app-sqlite
# Without Docker, against any Postgres you have:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/funnels npm run dev --prefix server
```

Configuration is environment-only, see `.env.example` and `docs/CONFIGURATION.md`. Nothing is required in development.

## Layout

```
server/    Hono API, services, repositories, SQL migrations, page model (cleaning, rendering, sanitising, converter), jobs, tests
web/       React app, design system (src/ui), page builder (src/builder), tests
edge/      optional Cloudflare Worker in front of the origin (cache, signed resolve, edge rate limits)
e2e/       Playwright browser tests (real mouse drags in the builder) and the screenshot generators
docs/      user guide, features, functions, architecture, operations and decision records (index: docs/README.md)
deploy/    Kubernetes, k6, ClickHouse schema, Cloudflare WAF rules
bench/, loadtest/   benchmarks and load tests
render.yaml, Dockerfile, docker-compose.yml   deployment
```

## Try it

1. Register, create a funnel (blank, template or AI), open a step in the builder. Drag blocks from the left panel onto the page, drag elements to reorder or nest them, double-click text to edit it, resize images by their handles, press `?` for the shortcuts, Save (Cmd or Ctrl+S) and View to see the saved page. The builder needs a screen of at least tablet size; see [docs/design/DESIGN.md](docs/design/DESIGN.md).
2. **Go live in one minute with no domain:** in the builder press **Publish** > keep *Built-in address (free)* > **Go live**, then copy or open the link (the same choices are in funnel > Settings > Go live; [docs/GO-LIVE.md](docs/GO-LIVE.md)). A free Cloudflare Pages address (connect Cloudflare first, in Settings > Publishing) and your own domain are the alternatives; after that **Publish** offers *Update live page* and *Take offline*.
3. Optional: add a domain on the Domains page; add the shown CNAME and TXT records and verify. Set a funnel live on it.
4. Funnels in test mode are viewable through the signed preview (Settings tab > Open signed preview).

Payments use a built-in test provider by default (orders are recorded, no card is charged). Set `PAYMENTS_PROVIDER=stripe` with the Stripe keys to use Stripe Connect hosted checkout ([docs/STRIPE.md](docs/STRIPE.md); not verified with a real payment yet). Deploying for free on Render: [docs/DEPLOY.md](docs/DEPLOY.md); every environment variable: [docs/CONFIGURATION.md](docs/CONFIGURATION.md); operations: [docs/RUNBOOK.md](docs/RUNBOOK.md). See docs/APPROACH.md for decisions and limits.
