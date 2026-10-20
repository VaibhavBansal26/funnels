# 0003. Tenancy: workspace_id on every row, repository-level scoping, 404 for foreign ids

Status: Accepted

## Context

Funnels, leads and orders belong to customers who must never see each other's data, and the legacy product leaked existence through 403s.

## Decision

Every business row has `workspace_id`; repositories and services always filter on it; a resource of another workspace is `404 NOT_FOUND`. Tests prove it for every resource type. Public endpoints derive the workspace from the funnel, never from the request.

## Alternatives considered

Row-level security in PostgreSQL (not available on SQLite, would diverge the engines); a database per tenant (operationally heavy at this scale).

## Consequences

A forgotten filter is the main risk; the tenancy suite and the route declaration tests guard it. Cross-workspace features (platform admin templates) are explicit and separate.
