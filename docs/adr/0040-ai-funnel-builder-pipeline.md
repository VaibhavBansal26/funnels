# 0040: Multi-stage AI funnel builder with deterministic assembly

## Context
The first generator asked a model for one JSON of copy and built pages from fixed layouts. That is safe but shallow (no strategy, no products, no assumptions, no progress, no audit) and a failed model call replaced everything at once.

## Decision
A pipeline of stages (brief, strategy, products, per-page copy, assembly, validation, save) in `server/src/ai/builder/`. The model is used for understanding, choosing among fixed funnel shapes and writing plain text; **code decides structure, forms' ids, prices, links and every page document** (assembled with the template DSL through the normal cleaner). Each model stage has a zod schema, semantic checks and a bounded repair loop, then falls back to a deterministic writer for that stage. The run is a queued job with checkpoints in `ai_generations` (resumable, cancellable, auditable) and progress on the existing SSE stream. A rubric validates the assembled pages and the claims guard keeps invented facts out. Products are only touched when asked, as draft catalog products.

## Alternatives
Let the model emit page JSON (unbounded surface, hard to validate, unsafe); one big prompt (no partial fallback, no progress); run synchronously in the request (timeouts, no cancel or resume).

## Consequences
Output is predictable and always valid; quality is bounded by the fixed layouts and the copy the model writes. A degraded build is still a valid funnel and says so. Costs several model calls per build (counted once against the AI quota). The real-model path is verified with fakes only.
