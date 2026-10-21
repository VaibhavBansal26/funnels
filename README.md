# Funnels

Build, publish and measure marketing funnels: a drag-and-drop page builder on [GrapesJS](https://grapesjs.com), templates, custom domains with DNS verification, public serving, analytics, leads and orders, signed webhooks and AI assistance. TypeScript, Hono, SQLite or PostgreSQL, React 19, Tailwind.

![The page builder](docs/design/builder-1440-light.webp)

More screens, light and dark, at three sizes: [docs/design/DESIGN.md](docs/design/DESIGN.md).

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
server/  Hono API, services, repositories, SQL migrations, page model (cleaning, rendering, sanitising, converter), tests
web/     React app, design system (src/ui), page builder (src/builder), tests
e2e/     Playwright browser tests (real mouse drags in the builder) and the screenshot generator
docs/    ARCHITECTURE, APPROACH, AI, TESTING, PERFORMANCE, MIGRATION-NOTES, PROVENANCE, SECURITY, design/
```

## Try it

1. Register, create a funnel (blank, template or AI), open a step in the builder. Drag blocks from the left panel onto the page, drag elements to reorder or nest them, double-click text to edit it, resize images by their handles, press `?` for the shortcuts, Save (Cmd or Ctrl+S) and View to see the saved page. The builder needs a screen of at least tablet size; see [docs/design/DESIGN.md](docs/design/DESIGN.md).
2. **Go live in one minute with no domain:** in the builder press **Publish** > keep *Built-in address (free)* > **Go live**, then copy or open the link (the same choices are in funnel > Settings > Go live; [docs/GO-LIVE.md](docs/GO-LIVE.md)). A free Cloudflare Pages address (connect Cloudflare first, in Settings > Publishing) and your own domain are the alternatives; after that **Publish** offers *Update live page* and *Take offline*.
3. Optional: add a domain on the Domains page; add the shown CNAME and TXT records and verify. Set a funnel live on it.
4. Funnels in test mode are viewable through the signed preview (Settings tab > Open signed preview).

Payments use a built-in test provider. See docs/APPROACH.md for decisions and limits.
