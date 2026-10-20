# Documentation

Start with the [README](../README.md) for what this is and how to run it.

## If you want to...

| ...do this | read |
|---|---|
| understand the system, data model, data layer and locks | [ARCHITECTURE.md](ARCHITECTURE.md) |
| know why something is the way it is | [APPROACH.md](APPROACH.md), [adr/](adr/0001-stack.md) |
| call the API | [API.md](API.md), [openapi.json](openapi.json) |
| set an environment variable | [CONFIGURATION.md](CONFIGURATION.md) |
| change or understand a rate limit | [RATE-LIMITING.md](RATE-LIMITING.md) |
| run it on PostgreSQL / Redis | [README](../README.md#databases), [CONFIGURATION.md](CONFIGURATION.md), [RUNBOOK.md](RUNBOOK.md) |
| deploy, roll back, back up, handle an incident | [RUNBOOK.md](RUNBOOK.md) |
| put Cloudflare in front, set WAF rules | [CLOUDFLARE.md](CLOUDFLARE.md) |
| see the numbers and how they were measured | [PERFORMANCE.md](PERFORMANCE.md) |
| run or write tests | [TESTING.md](TESTING.md), [CONTRIBUTING](../CONTRIBUTING.md) |
| understand the AI features | [AI.md](AI.md) |
| review security | [SECURITY.md](SECURITY.md) |
| decode a term or a legacy name | [GLOSSARY.md](GLOSSARY.md), [MIGRATION-NOTES.md](MIGRATION-NOTES.md) |
| see what changed | [CHANGELOG](../CHANGELOG.md) |

## Index

| Document | Description |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Context, containers, data model, data layer, key flows, domain state machine, deployment, scaling limits, edge layer (Mermaid diagrams) |
| [APPROACH.md](APPROACH.md) | How and why: decisions, security notes, limitations, phase decision records |
| [API.md](API.md) | Conventions, errors, pagination, concurrency, rate limit headers, runnable curl examples |
| [openapi.json](openapi.json) | OpenAPI 3.1 generated from the route declaration (do not edit) |
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable with default, example and security notes (generated) |
| [RATE-LIMITING.md](RATE-LIMITING.md) | Limiter design, algorithms, failure modes, every policy (table generated), tuning |
| [CLOUDFLARE.md](CLOUDFLARE.md) | Worker, signed resolve, cache and purge, edge rate limiting and WAF rules |
| [PERFORMANCE.md](PERFORMANCE.md) | Benchmarks with machine, date and method; the ingestion regression investigation |
| [TESTING.md](TESTING.md) | Strategy, the database matrix, real PostgreSQL and Redis suites, edge-case catalogue |
| [RUNBOOK.md](RUNBOOK.md) | Deploy, rollback, backups, migrations, incident playbooks, alerts and SLO targets |
| [SECURITY.md](SECURITY.md) | Threat model summary, data handled, PII policy, secrets, reporting |
| [AI.md](AI.md) | AI providers, prompts, fallbacks, cost and safety |
| [MIGRATION-NOTES.md](MIGRATION-NOTES.md) | Legacy collections and endpoints mapped to the new ones |
| [GLOSSARY.md](GLOSSARY.md) | Domain terms and legacy-to-new names |


## Architecture decision records

| ADR | Decision | Status |
|---|---|---|
| [0001](adr/0001-stack.md) | Stack: TypeScript, Hono, zod, React, no ORM | Accepted |
| [0002](adr/0002-databases.md) | SQLite default, PostgreSQL for production, behind one async Db interface | Accepted |
| [0003](adr/0003-tenancy.md) | Tenancy: workspace_id on every row, repository-level scoping, 404 for foreign ids | Accepted |
| [0004](adr/0004-soft-delete.md) | Soft delete funnels, with domain detach and owner-only purge | Accepted |
| [0005](adr/0005-idempotency.md) | Idempotency through unique indexes and client-supplied keys | Accepted |
| [0006](adr/0006-edge.md) | Optional Cloudflare Worker with a signed resolve endpoint that fails closed | Accepted |
| [0007](adr/0007-event-buffer.md) | Write-behind buffer for analytics events | Accepted |
| [0008](adr/0008-rollups.md) | Application-maintained rollups; no visitor_days; no triggers | Accepted |
| [0009](adr/0009-concurrency.md) | Optimistic page versions plus ordered row locks | Accepted |
| [0010](adr/0010-rate-limiting.md) | Rate limiting: GCRA and sliding windows in Redis Lua, one declaration of routes and policies | Accepted |
| [0011](adr/0011-ids.md) | App-generated, time-sortable text ids | Accepted |
| [0012](adr/0012-docs-from-code.md) | Generate the documentation that can drift | Accepted |
