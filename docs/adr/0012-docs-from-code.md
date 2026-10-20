# 0012. Generate the documentation that can drift

Status: Accepted

## Context

Hand-written configuration and API references go stale.

## Decision

The env reference, OpenAPI document and rate limit policy table are generated from the zod schema, the route declaration and the policy registry; `docs:check` (in `npm test` and CI) fails when they differ from a fresh generation, and also checks links, the index, Mermaid blocks and runnable examples.

## Alternatives considered

Hand-maintained docs with review discipline; OpenAPI-first code generation.

## Consequences

Adding a route, variable or policy needs a description in code; the build stops otherwise.
