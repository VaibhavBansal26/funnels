# 0025: AI analytics summary grounded by a number guard

## Context
A narrative about revenue is only useful if every figure in it is real. Models invent numbers, and product names are text any user can write.

## Decision
`POST /api/analytics/summary` computes an evidence object in SQL (this period, the previous one, per currency, top products, funnel steps). The model sees only that object (names cleaned and delimited as data). Its answer must match a schema (narrative plus exactly three prioritised actions, plain text) and pass `numberGuard`: every number in the text must exist in the evidence, as is, rounded, or as the percentage of a rate; names and the period's dates are blanked first; links and markup are refused. One failure replaces the whole answer with the deterministic narrator, which writes only numbers it copies or derives arithmetically (and is itself property-tested against the guard). The per-workspace AI quota applies as for the other AI routes.

## Alternatives
Trust the model with a "do not invent numbers" instruction (no guarantee); strip offending numbers (leaves misleading sentences); let the model call tools that run SQL (more surface, no stronger guarantee than the evidence object).

## Consequences
A figure on screen always came from the database. The guard is strict: a model that writes "about 3" when the evidence has no 3 is replaced by the narrator (`source: "fallback"`), so the narrator's wording is what most users see until prompts are tuned. Numbers spelled as words are not checked (the prompt forbids them).
