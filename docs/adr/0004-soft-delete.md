# 0004. Soft delete funnels, with domain detach and owner-only purge

Status: Accepted

## Context

Deleting a funnel by mistake is costly and its URLs must stop being served at once and its paths freed.

## Decision

`DELETE /funnels/{id}` moves the funnel to the trash: it leaves lists and public serving, loses its domain (freeing paths) and keeps data; restore returns it in test mode; `purge` (owner, trash only) hard-deletes with cascade.

## Alternatives considered

Hard delete only; a separate archive table.

## Consequences

Queries must filter `deleted_at IS NULL`; analytics of a trashed funnel remain until purge.
