# Testing

Vitest in both packages. Server tests are HTTP integration tests through `app.request()` against an in-memory SQLite database with injected fakes (clock, DNS resolver, HTTP client, host lookup, AI provider). No test touches the network.

```
npm test                  # server + web
npm test --prefix server  # 400+ tests, about 10 s
npm test --prefix web     # ~50 tests (jsdom + Testing Library)
npm run typecheck         # tsc --noEmit in both packages
npm run build             # tsc + vite build
```

Test helpers (`server/test/helpers.ts`): `makeHarness()` builds an app with a controllable clock (`FakeClock`), `FakeDns`, `FakeHttp`; `register`, `member`, `activeDomain`, `makeFunnel`, `fromTemplate`, `formTarget`, `checkoutTarget` set up common worlds.

## Edge-case catalogue (server)

| Area | File | Covered |
|---|---|---|
| Renderer XSS | `blocks.render.test.ts` | script tags, attribute injection, `javascript:`/`data:`/tab-split/fullwidth URLs, CSS injection, unicode, empty doc, unknown block, 400-block limit, nesting limit, columns cap, determinism |
| Sanitiser and schema | `blocks.sanitize-schema.test.ts` | handlers, entity/whitespace URL tricks, malformed nesting, style filtering, hostile 50,000-deep JSON, versions |
| Paths | `steps.test.ts` | accept/reject table, intra-funnel and cross-funnel collisions, `/path-NNNN` suggestions, resolution subset validation, create-with-domain |
| Reorder | `steps.test.ts` | duplicate ids/orders, partial set, foreign ids, bad numbers, gap normalisation, link re-render |
| State machine | `funnels.test.ts`, `domains.test.ts` | live needs active domain, test detaches, domain loss/deletion revert in one transaction, rollback when the delete or the status update fails (SQLite triggers inject the failure) |
| Versions | `pages.test.ts` | pruning at exactly 10/11, per step, autosave exempt, restore creates a backup, version conflicts, scripts policy |
| Funnels | `funnels.test.ts` | search/filters/sort/pagination, stats, duplicate naming, soft delete/restore/purge, tag case-insensitivity and scoping |
| Tenancy and roles | `tenancy.test.ts`, `auth.test.ts` | 404 for every resource type, no existence leak, role matrix, instant role changes |
| Public events | `public.test.ts` | unknown/deleted funnel, malformed, oversized (413), bots, duplicate idempotency, rate limit 429 + Retry-After |
| Forms and orders | `public.test.ts`, `exports.test.ts` | lead dedupe, honeypot, field validation, idempotent checkout, bump/upsell, decline, CSV injection |
| Analytics | `analytics.test.ts` | zero visits, rounding, inclusive range edges, time-zone and DST day boundaries, series |
| Webhooks | `webhooks.test.ts` | signature, backoff schedule, dead letter, SSRF table (v4/v6/mapped/NAT64/decimal/octal), DNS rebinding, redirects not followed |
| Preview and serving | `serving.test.ts` | token expiry/tamper/cross-funnel/cross-workspace, ETag/304, cookies and UTM sanitising, 301/home/404 rules, host matching |
| AI | `ai.test.ts` | invalid JSON, schema mismatch, empty, throws, refusal, truncation, prompt injection, fallback, invented numbers, rate limit and daily cap |
| DNS | `domains.test.ts` | pending/active/failed transitions, resolver errors, timeout, job polling with backoff |

## Web tests

`builder.test.ts` (undo/redo reducer, coalescing, dirty tracking, tree operations, serialisation round trip), `components.test.tsx` (block inspector, keyboard reorder of steps with rollback, API error display, login validation, modal focus trap, toasts), `pages.test.ts` (reorder model, validators, settings patch, chart helpers), `api/client.test.ts`.

## Not covered

Real browsers (drag and drop, the sandboxed canvas script), real DNS, real Anthropic calls, concurrent multi-process access to the SQLite file.
