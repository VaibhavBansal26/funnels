# 0001. Stack: TypeScript, Hono, zod, React, no ORM

Status: Accepted

## Context

A standalone product replacing a legacy MongoDB/GrapesJS funnel builder, to be small enough to understand and run with zero configuration.

## Decision

TypeScript everywhere (strict). Server: Hono, zod validation, `jose` JWTs, scrypt hashing, hand-written repository layer with SQL migrations. Web: React 19, Vite, react-router, TanStack Query, plain CSS. One block renderer (`server/src/blocks`) shared by server and builder through a Vite alias.

## Alternatives considered

Express/Fastify (heavier or no better fit for edge-style handlers); an ORM such as Prisma/Drizzle (a dependency and a rewrite of every query for a codebase this size); a UI kit (bundle size, budgets are enforced in CI); GrapesJS (the legacy editor; a typed block document is easier to validate, render and test).

## Consequences

Few dependencies and fast tests. SQL is explicit and portable only because we keep it so (ADR 0002). Block schema changes need a document migration (`DOC_VERSION`).
