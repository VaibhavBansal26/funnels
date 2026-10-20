## What and why

## Checklist
- [ ] Tests added or updated (`npm test` passes; PostgreSQL-affecting changes also ran with `TEST_DB=pglite`)
- [ ] **Docs updated in this PR** (affected docs/*.md, `npm run docs:config` / `docs:api` regenerated, `npm run docs:check` passes)
- [ ] `CHANGELOG.md` has an entry under Unreleased (user-visible changes)
- [ ] New route has a row in `server/src/routes/spec.ts` with auth and limiter policies
- [ ] New config variable is in `config.ts`, `config.docs.ts` and `.env.example`
- [ ] Schema change has both a SQLite and a PostgreSQL migration
- [ ] No secrets, no `.env`, no new unauthenticated surface without a rate limit policy
- [ ] Measured numbers (if any) are labelled with machine, date and method
