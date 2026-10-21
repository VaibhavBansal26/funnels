# 0042: Google reviews from the Places API (New), server-side, short-lived cache

## Context
Customers want their Google rating and reviews on funnel pages. Google's terms restrict caching Places content, require attribution (author, avatar, link, Google Maps) and forbid presenting content misleadingly; review markup for search engines from self-served reviews is against Google's structured data guidance.

## Decision
Reviews are fetched only by the server with a platform or per-workspace key (encrypted, masked) through the SSRF-guarded outbound fetch. Place ids are stored for as long as blocks use them; review content is cached for `GOOGLE_REVIEWS_CACHE_TTL_S` (default 1 hour, 0 = never stored) and never served past expiry. Text is shown exactly as returned (only control characters removed). Attribution is always rendered (author with link and avatar, "Reviews from Google Maps" with `googleMapsUri`); no structured data is emitted. Both serving paths render a snapshot into the page and refresh it from `GET /public/reviews/:blockToken` (allow-listed CORS). Per-workspace daily quota, a per-place circuit breaker and a refresh job protect the key. Without a key or a result the block shows the testimonials the author typed, labelled as customer feedback.

## Alternatives
Scrape or embed a widget (against terms, third-party scripts); store reviews indefinitely (against terms); fetch from the browser (exposes the key); no cache (cost and quota).

## Consequences
Whether even a one-hour cache fits your agreement with Google is your call (docs/REVIEWS.md says how to turn it off). Pages briefly show a stale snapshot until the runtime refresh. Not exercised against the real Google API.
