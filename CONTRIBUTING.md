# Contributing

## Setup

Node 22+ (developed on 24), npm.

```bash
npm run install:all
npm run dev                 # API :3000, Vite :5173
npm run seed                # optional demo data
```

Zero config uses SQLite. For PostgreSQL set `DATABASE_URL`; for the Redis rate limiter set `REDIS_URL`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Tests

```bash
npm test                         # server (SQLite + PGlite), web, edge, docs checks
TEST_DB=sqlite npm test --prefix server     # fast loop (about 10 s)
TEST_DB=pglite npm test --prefix server     # PostgreSQL dialect in WASM
TEST_PG_URL=postgres://user:pass@localhost:5432/postgres TEST_DB=pg npm test --prefix server   # real PostgreSQL
npm run typecheck && npm run build && npm run check:size
npm run e2e                      # Playwright against the built app (needs `npx playwright install chromium` once)
npm run design:shots --prefix e2e   # regenerate docs/design (after `npm run build`)
```

The Redis suites start their own `redis-server` (install it; they skip when it is missing, CI installs it). More in [docs/TESTING.md](docs/TESTING.md).

## Branches and commits

Branch from `main`; conventional commit messages (`feat(scope):`, `fix:`, `perf:`, `docs:`, `test:`, `refactor:`, `chore:`), one logical change per commit, tests and docs in the same commit as the code. Do not commit secrets or `.env`.

## Changing things

* **A route**: add it and its row in `server/src/routes/spec.ts` (auth, schemas, limiter policies), then `npm run docs:api`. Tests fail until the row exists.
* **A limit**: `server/src/ratelimit/policies.ts`, then `npm run docs:config`.
* **Configuration**: add the variable to `server/src/config.ts` and its description to `server/src/config.docs.ts` (it does not compile without), update `.env.example`, run `npm run docs:config`.
* **The schema**: a new numbered file in both `server/src/db/migrations/sqlite/` and `.../pg/`; the equivalence test compares them. Services use `deps.db` (or the handle given inside `inTx`) and `db.dialect` helpers; no SQLite-only SQL outside `src/db`. Take locks in the documented order (ARCHITECTURE.md, Data layer).
* **A page component** (what a page may contain): its allow-list entry and typed props in `server/src/pagemodel/shared/` (`clean.ts`, `props.ts`, `markup.ts`), its editor type in `web/src/builder/editor/types.ts`, a block in `editor/blocks.ts`, an editor for its props in `web/src/builder/panels/traits.tsx`, a case in `server/test/pagemodel.xss.test.ts`. If its shape changes later, bump `COMPONENT_VERSION` and register a migration. Anything the browser could forge (prices, fields, URLs) must be derived by the server from the typed props, never accepted from the request.
* **A CSS property or HTML tag authors may use**: add it to `shared/cssvalues.ts` or the sanitiser options and prove it in the XSS corpus; unknown ones are dropped on purpose.
* **Colours and spacing in the web app**: tokens in `web/src/styles.css` (`web/src/ui/tokens.test.ts` checks the contrast), components in `web/src/ui/`; no literal colours in components.
* **A decision worth remembering**: add an ADR in `docs/adr/`.

## Docs

Docs are part of done. `npm run docs:check` (also part of `npm test` and CI) fails on broken links or anchors, a doc missing from [docs/README.md](docs/README.md), a config variable missing from CONFIGURATION.md, stale generated files, invalid Mermaid, routes without a documented entry, a missing `Unreleased` changelog section, and failing runnable examples in docs/API.md. Add user-visible changes to [CHANGELOG.md](CHANGELOG.md).

## Reporting security issues

See [docs/SECURITY.md](docs/SECURITY.md).
