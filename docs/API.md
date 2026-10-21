# API

Base path `/api`. The machine-readable contract is [openapi.json](openapi.json) (generated from `server/src/routes/spec.ts` with the zod request schemas: `npm run docs:api`); this page has the conventions and worked examples. Examples marked **runnable** are executed against an in-process app by `server/test/docs.test.ts`, so they cannot rot; `$BASE` is `http://localhost:3000` and `# save NAME=path` stores a value from the previous response.

## Conventions

* JSON in, JSON out. Authentication: `Authorization: Bearer <token>` from register/login. Roles: `owner > admin > member`; a role-gated route answers `403 FORBIDDEN` to a lower role.
* **Errors** are `{ "error": { "code": "SNAKE_CASE", "message": "...", "details": ... } }` with the matching HTTP status. Validation failures are `400 VALIDATION_ERROR` with `details: [{ path, message }]`. A resource that does not exist **or belongs to another workspace** is `404 NOT_FOUND` (existence is never leaked).
* **Lists** are `{ "data": [...], "pagination": { "page", "limit", "total", "totalPages" } }`; `limit` is at most 100. CSV exports stream newest first in keyset pages and have no row cap.
* **Concurrency**: `PUT .../page` takes the `version` you loaded; a stale version is `409 VERSION_CONFLICT` with `details.currentVersion`. Exactly one of several concurrent saves from the same version wins.
* **Rate limits**: every response of a limited route carries `RateLimit-Policy`, `RateLimit` and `X-RateLimit-*`; a refusal is `429` with `Retry-After` and `{ "error": { "code": "RATE_LIMITED", "retry_after_s": 7, "policy": "public.forms" } }`. Concurrency refusals are `503 OVERLOADED`. Details and every policy: [RATE-LIMITING.md](RATE-LIMITING.md). Send an `Idempotency-Key` header on retried writes so a retry is not counted twice.
* Timestamps are ISO-8601 UTC strings; money is integer cents on the wire inside orders (`amountCents`) and decimal in analytics (`gross`).

## Register, log in, create a funnel (runnable)

```bash
# runnable
curl -s -X POST $BASE/api/auth/register -H 'content-type: application/json' -d '{"email":"ada@example.test","password":"correct horse battery","name":"Ada"}'
# save TOKEN=token
curl -s $BASE/api/auth/me -H "authorization: Bearer $TOKEN"
curl -s -X POST $BASE/api/funnels -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Spring launch"}'
# save FUNNEL=id
# save STEP=steps.0.id
curl -s "$BASE/api/funnels?limit=10&search=spring" -H "authorization: Bearer $TOKEN"
```

## Edit a page with optimistic concurrency (runnable)

```bash
# runnable
curl -s $BASE/api/funnels/$FUNNEL/steps/$STEP/page -H "authorization: Bearer $TOKEN"
# save VERSION=version
curl -s -X PUT $BASE/api/funnels/$FUNNEL/steps/$STEP/page -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"version":$VERSION,"doc":{"version":2,"project":{"assets":[],"styles":[],"pages":[{"frames":[{"component":{"type":"wrapper","components":[{"type":"fn-heading","tagName":"h1","components":[{"type":"textnode","content":"Hello"}]}]}}]}]}}}'
# a second save from the same (now stale) version is refused:
curl -s -X PUT $BASE/api/funnels/$FUNNEL/steps/$STEP/page -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"version":$VERSION,"doc":{"version":2,"project":{"assets":[],"styles":[],"pages":[{"frames":[{"component":{"type":"wrapper","components":[]}}]}]}}}'
```

The page document is a GrapesJS project: `{ "version": 2, "project": { assets, styles, pages } }`. The server cleans it against allow-lists and derives `forms` and `products` (prices, product links, form fields) from the typed component props, so a client cannot choose a price or a form definition; the response of `GET .../page` shows the derived lists. Legacy block documents (`{"version":1,"blocks":[...]}`) are still accepted and converted on save. The second call answers `409` `{"error":{"code":"VERSION_CONFLICT","details":{"currentVersion":...}}}`; reload and re-apply.

## Track visitors (public, runnable)

```bash
# runnable
curl -s -X POST $BASE/api/public/events -H 'content-type: application/json' -H 'user-agent: Mozilla/5.0 Chrome/120' -d '{"funnelId":"$FUNNEL","stepId":"$STEP","type":"page_view","visitorId":"v-1"}'
curl -s "$BASE/api/funnels/$FUNNEL/analytics?from=2026-03-01&to=2026-03-31&tz=America/New_York" -H "authorization: Bearer $TOKEN"
```

`202 {"ok":true,"recorded":true}`. Bots, previews, unknown funnels and duplicates answer 202 with `recorded:false` and a `reason`, so clients never learn which ids exist. Events are buffered for up to `EVENT_BUFFER_MS` and analytics reads flush the buffer first. Browsers may only send `page_view` and `optin`; orders come from the server-side checkout.

## Analytics ranges

`GET /api/funnels/{id}/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City` takes inclusive local days in the given IANA zone (default: last 30 days, UTC; at most 366 days). The series has one entry per local day. Counts come from 15-minute UTC rollups, so every real zone offset lands on a bucket edge; funnel-level unique visitors are exact distinct counts over raw events.

## Forms and checkout

`POST /api/public/forms/{funnelId}/{stepId}/{blockId}` with `{ "fields": {...}, "consent": true, "submissionId": "..." }`: validated against the block's own field definitions (`422 VALIDATION_ERROR` with `details.fields`), lead deduplicated by email per workspace, `submissionId` makes a retry a no-op (`duplicate: true`). `POST /api/public/checkout/...` prices come from the stored block, never from the request. Both fail closed when the rate limiter is unavailable.

## Webhooks

Create with `POST /api/webhooks { url, events: ["funnel.optin","funnel.purchase"] }`; the signing secret is shown once. Deliveries are `POST`s with `x-funnels-event`, `x-funnels-delivery`, `x-funnels-timestamp` and `x-funnels-signature: sha256=HMAC_SHA256(secret, "{timestamp}.{body}")`. Retries: 30 s x 2^n backoff, dead-lettered after `WEBHOOK_MAX_ATTEMPTS`. Redirects are never followed; private addresses are refused (SSRF).

## AI funnel builder and Google reviews

```bash
# start a build (202), poll it, cancel it, rewrite one page of the result
curl -s -X POST $BASE/api/ai/builds -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Neighbourhood bakery in Austin, custom cakes from $40 to $120","options":{"products":"create","redactPii":true}}'
curl -s $BASE/api/ai/builds/$ID -H "authorization: Bearer $TOKEN"          # stages, assumptions, report, funnelId
curl -s -X POST $BASE/api/ai/builds/$ID/cancel -H "authorization: Bearer $TOKEN"
curl -s -X POST $BASE/api/ai/builds/$ID/steps/s1/regenerate -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"instruction":"shorter"}'
# builder assistant: operations for an outline (the builder sends the live page)
curl -s -X POST $BASE/api/ai/edit -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"instruction":"make the hero shorter","outline":{"id":"root","type":"wrapper","children":[{"id":"h1","type":"fn-heading","tag":"h1","text":"We bake the best cakes in town"}]},"selectedId":"h1"}'
# Google reviews: settings, place search, public data of a block
curl -s -X PUT $BASE/api/google-reviews/settings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"apiKey":"<your Places API key>"}'
curl -s -X POST $BASE/api/google-reviews/search -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"query":"corner bakery austin"}'
curl -s $BASE/public/reviews/$BLOCK_TOKEN
```

Errors: `409 BUILD_IN_PROGRESS`, `429 AI_DAILY_CAP_REACHED`, `422 VALIDATION_FAILED` (regenerate), `409 PLACES_NO_KEY`, `502 PLACES_KEY_REJECTED`, `429 PLACES_QUOTA`. See [AI-BUILDER.md](AI-BUILDER.md) and [REVIEWS.md](REVIEWS.md).

## Rate limit headers

```
RateLimit-Policy: "api.workspace";q=600;w=60
RateLimit: "api.workspace";r=187;t=12
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 187
X-RateLimit-Reset: 12
```

`q` is the policy's rate per window `w` seconds, `r` what is left in the bucket, `t` seconds until it is full again; the policy shown is the tightest layer for that request.

## Platform admin

`/api/admin/*` is for accounts listed in `PLATFORM_ADMIN_EMAILS` (templates, rate limit blocks/allows, per-workspace plan). Not part of the product UI.
