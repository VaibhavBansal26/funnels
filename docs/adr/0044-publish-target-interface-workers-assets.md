# 0044. A PublishTarget interface and the experimental Workers static assets target

Status: Proposed / experimental (unverified against real Cloudflare)

## Context

Cloudflare's guidance (read 2026-10-21) is to start new projects on Workers static assets; Pages stays supported ([Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [Pages](https://developers.cloudflare.com/pages/)). The app published only to Pages, with the Pages client called directly from the deployment state machine. Pages allows 100 projects per account and the app uses one per funnel; Workers allows 100 Workers on Free and 500 on Paid ([limits](https://developers.cloudflare.com/workers/platform/limits/)).

## Decision

* `publish/target.ts` defines `PublishTarget` (verify, count and create projects, `deploy(bundle)`, deployment state, rollback, custom domains) with `PagesTarget` (the existing client, unchanged) and `WorkersTarget` (`cfworkers.ts`). `funnel_publish.target` gains `cloudflare-workers-assets` (migration 043); the state machine in `services/publishing.ts` calls the interface and no longer knows Pages endpoints.
* The Workers deployment id stored in the history is the Worker *version* id, which is what a rollback needs (`POST .../deployments` with that version at 100%). The free `workers.dev` address is a system domain of the same kind as the pages.dev one (ADR 0043); its host is derived from the account's workers.dev subdomain, and a missing subdomain is a specific, explained error.
* A funnel uses one Cloudflare target at a time; changing it goes through the origin target so the old site is deliberately paused, kept or deleted.
* Everything is labelled experimental. Assumptions the documentation does not settle are isolated in `cfworkers.ts` and listed in docs/CLOUDFLARE-PAGES.md; `scripts/cf-workers-smoke.ts` is how they get checked.

## Alternatives considered

Replacing Pages with Workers (nothing verified against either; Pages stays the default); a Wrangler subprocess (see ADR 0030); Workers for Platforms (no project limit, but dispatch namespaces, a different plan and more surface).

## Consequences

Adding a third target is a class plus a migration of one CHECK constraint. Two experimental code paths share the same fake, so a misreading of the documentation could be mirrored in both client and fake; only the smoke scripts can catch that.
