# 0031. Ads: generated pixels, server-side conversions from verified events, first/last-touch attribution, spend joined by campaign

Status: Accepted (networks' APIs unverified: see [ADS.md](../ADS.md))

## Context

Customers run paid traffic to funnels and need (1) the networks' tags on their pages without hand-pasting scripts, (2) conversion reports that survive ad blockers and browser restrictions, (3) to know which campaign produced a lead or sale, and (4) to compare that with what they spent. Creating campaigns inside the networks is out of scope: it needs each platform's app review and OAuth.

## Decision

* **Pixel snippets are generated from validated IDs, never accepted as script text.** Strict per-network formats are enforced on save and again at render. The page gets one inline script whose configuration is JSON with the dangerous characters escaped; the owner-only custom code stays the only arbitrary-script path.
* **Consent is part of the runtime**, not a plugin: opt-in/opt-out, a region rule, Do Not Track / Global Privacy Control, Google Consent Mode v2 signals, queued events. The visitor's state travels to the server with the attribution record so **server-side conversions obey it**.
* **Conversions come from server events**: a lead accepted by the form endpoint and an order persisted after payment verification, written as delivery rows in the same transaction (so they exist iff the record does), delivered by the job queue with retries, backoff and dead letters, deduplicated by `(integration, event name, event id)`. The browser pixel and the server use the same event id for Meta/TikTok deduplication.
* **A `ConversionsProvider` interface** (Meta, GA4, TikTok) with pure `build`/`prepare`/`interpret`; requests are built and **hashed at event time and stored without their secret**, so retries are exact and the log holds no raw PII. Hashing/normalisation per network is a table-tested pure module.
* **Attribution is stored per visitor** (first touch, last non-direct touch, browser ids with retention for IP/UA) and **stamped onto leads and orders** (flat columns for reporting plus JSON), never rewritten afterwards. Sanitisation of every incoming value is centralised and tested with hostile input.
* **Spend is money in minor units per currency per row; reports are single-currency** (a `currency` parameter), so currencies cannot be summed by accident. Spend joins results by (platform, campaign) with alias folding, an explicit mapping table, and an `unmatched` list; results of campaigns without spend are kept apart so ROAS compares like with like.
* Permissions: `integrations:manage` (tokens, pixels), `ads:read`, `ads:write`; additive API v1 endpoints with JSON Schemas and contract tests.

## Alternatives considered

Letting users paste tag snippets (the exact XSS and breakage surface the page sanitiser exists to remove); sending conversions from the browser only (blocked by blockers and ITP, forgeable by visitors); sending from the Stripe webhook handler directly (couples billing to ads and loses the lead case; the persisted order is the single verified point); one multi-currency report with conversion (needs rates and dates, and invents numbers); last-touch only (the question "what started this" is real); modelling spend as a time series of floats (rounding errors accumulate; money elsewhere is integer minor units).

## Consequences

A visitor who declines consent is invisible to server-side conversions as well as to pixels; reports will show fewer conversions than payments and say why (skipped deliveries). Click ids are only available for visitors who allowed them. Attribution is as good as the beacon's report: a visitor who never loaded it has no touch, and is counted as direct. Ad networks change APIs (Graph versions retire in about two years); the version is configuration.
