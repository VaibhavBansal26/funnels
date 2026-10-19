# Funnels

Build, publish and measure marketing funnels: a block-based page builder, templates, custom domains with DNS verification, public serving, analytics, leads and orders, signed webhooks and AI assistance. TypeScript, Hono, `node:sqlite`, React 19.

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

Configuration is environment-only, see `.env.example`. Nothing is required in development.

## Layout

```
server/  Hono API, services, repositories, SQL migrations, block renderer, tests
web/     React app, builder, tests
docs/    ARCHITECTURE, APPROACH, AI, TESTING, MIGRATION-NOTES
```

## Try it

1. Register, create a funnel (blank, template or AI), open a step in the builder.
2. Add a domain on the Domains page; add the shown CNAME and TXT records and verify. Set a funnel live on it.
3. Funnels in test mode are viewable through the signed preview (Settings tab > Open signed preview).

Payments use a built-in test provider. See docs/APPROACH.md for decisions and limits.
