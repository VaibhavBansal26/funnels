# Template library

Templates are a backend resource: stored in the database, served by the API, filtered, previewed and cloned into a workspace as a new test funnel. 28 built-in templates ship with the app; an administrator can add more as JSON without a deploy. Decision record: [ADR 0023](adr/0023-template-library.md).

## What a template is

A template has metadata (slug, name, description, category, industry, recommended goal, tags, brand accent), an ordered list of steps (name, path, kind, a GrapesJS page document) and product placeholders ("slots"). The TypeScript shape is `TemplateDef` in `server/src/templates/types.ts`; the admin import and export format is the same shape wrapped in `{ "format": "funnels-template", "formatVersion": 1, "template": ... }`.

- **Step kinds** (`landing`, `optin`, `registration`, `replay`, `sales`, `checkout`, `upsell`, `downsell`, `booking`, `application`, `survey`, `thankyou`, `page`) describe what a step is for; they never change how it is served.
- **Product slots** (`products`): each checkout block of a template carries `slot: "<key>"` and the template lists the slot (key, role main/bump/upsell/downsell, sample name, description, type, amount, currency, interval, trial). Using the template binds every slot to a product of the workspace catalog (see [PRODUCTS.md](PRODUCTS.md#templates-and-the-wizard)). A template holds no workspace ids: catalog links are stripped on import and when publishing a funnel as a template.

## The library

| Template | Category | Industry | Goal | Steps | Products |
|---|---|---|---|---|---|
| `lead-magnet` | Lead generation | general | leads | Landing page → Thank you | none |
| `webinar-registration` | Events | education | webinar | Registration → Confirmation | none |
| `product-launch` | Sales | general | sales | Teaser → Launch page → Thank you | main: Aurora Pack (launch price) (129 USD) |
| `sales-page-bump-upsell` | Sales | education | sales | Sales page → One-click upsell → Thank you | main: Email Marketing Masterclass (97 USD); bump: Done-for-you subject line pack (17 USD); upsell: 1:1 coaching call (45 min) (97 USD) |
| `thank-you-page` | Follow-up | general | engagement | Thank you | none |
| `book-a-call` | Booking | coaching | booking | Booking page → Confirmation | none |
| `newsletter-signup` | Lead generation | media | leads | Signup | none |
| `ecommerce-single-product` | Ecommerce | ecommerce | sales | Product page → Refill offer → Thank you | main: Ember Glass Candle (38 USD); bump: Gift wrap and note (6 USD); upsell: Candle refill 3-pack (45 USD) |
| `saas-free-trial` | Software and apps | saas | sales | Landing page → Start trial → Welcome | main: Pro plan (29 USD/month) |
| `saas-demo-booking` | Software and apps | saas | booking | Landing page → Demo requested | none |
| `online-course-membership` | Courses and membership | education | sales | Sales page → Welcome | main: Founding membership (annual) (249 USD/year); bump: Workbook bundle (19 USD) |
| `coaching-program` | Booking | coaching | booking | Landing page → Apply → Request received | none |
| `donation-nonprofit` | Nonprofit | nonprofit | donations | Campaign page → Thank you | main: One-time gift (50 USD); bump: Cover the processing fees (5 USD) |
| `upsell-downsell-pack` | Follow-up | general | sales | Upsell → Downsell → Thank you | upsell: VIP Implementation Pack (147 USD); downsell: Quick-start Edition (47 USD) |
| `lead-magnet-checklist` | Lead generation | general | leads | Opt-in → Thank you | none |
| `webinar-replay` | Events | education | webinar | Registration → Replay → Thank you | none |
| `waitlist-prelaunch` | Lead generation | saas | leads | Waitlist → You are in | none |
| `giveaway-contest` | Lead generation | ecommerce | engagement | Enter → Entered | none |
| `survey-quiz` | Lead generation | general | engagement | Intro → Quiz → Your result | none |
| `app-download` | Software and apps | saas | engagement | Landing → Check your phone | none |
| `event-ticketing` | Events | events | events | Event → Tickets → You are going | main: General admission (79 USD); bump: Workshop day pass (39 USD) |
| `local-dentist` | Local services | dental | booking | Landing page → Request received | none |
| `local-gym` | Local services | fitness | leads | Landing page → Pass on its way | none |
| `local-restaurant-bakery` | Local services | food | booking | Landing page → Confirmed | none |
| `local-real-estate` | Local services | real-estate | leads | Landing page → Valuation in progress | none |
| `local-home-services` | Local services | home-services | leads | Landing page → Quote requested | none |
| `application-funnel` | Booking | coaching | booking | Landing page → Application → Under review | none |
| `agency-lead-gen` | Agencies | agency | leads | Landing page → Audit requested | none |

Every template is written with the page-builder DSL (`pm.*`) and the shared kit (`server/src/templates/kit.ts`): native GrapesJS data, real copy, a distinct palette and layout per template. Illustrations are CSS compositions (gradients, rounded boxes, conic rings: browser and phone mock-ups, charts, discs). Inline SVG and `data:image/svg+xml` are deliberately not used: the page sanitiser accepts only raster data URIs (ADR 0022), and relaxing that for decoration was not worth widening the attack surface. No template loads a remote image or font.

## Seeding and versions

`seedTemplates` runs at boot (idempotent, deterministic ids `tpl_<slug>` and `tpl_<slug>_<n>`, `ON CONFLICT DO NOTHING`, safe with several replicas booting at once). Each built-in has an integer `version`. A stored built-in template is replaced (metadata and steps) only when its stored version is lower than the code's, it has `source = 'builtin'` and it was not edited by an administrator (`customized = 0`). Imported templates (`source = 'imported'`), templates published from a funnel (`source = 'user'`) and edited built-ins are never touched. Funnels created from a template are copies and never change when a template is upgraded. To change a built-in: edit its file in `server/src/templates/library/` and raise `version`.

## API

| Request | What it does |
|---|---|
| `GET /api/templates?category=&industry=&goal=&tag=&checkout=true&search=&page=&limit=` | The gallery: filters, search over name, description, tags and industry, pages (default 24, max 100) and `facets` (counts of industries, goals and tags). `ETag`: send `If-None-Match` and get `304`. |
| `GET /api/templates/categories` | Categories with template counts. |
| `GET /api/templates/{id}` | Summary, steps (id, name, path, kind), product slots, `thumbnail` and `preview` (the first step rendered as an inert page). `?docs=true` adds the step documents. `ETag`. |
| `GET /api/templates/{id}/html?step=2` | One step rendered as a standalone page for a sandboxed iframe. `ETag`. |
| `POST /api/templates/{id}/use` | Clone as a new test funnel. Optional body `{ "name": "...", "bindings": { "main": { "priceId": "prc_..." }, "bump": { "create": true } } }`. Unbound slots are created from the template defaults (equal products are reused). All or nothing: a refused binding creates no funnel. |
| `POST /api/admin/templates/import` | Platform administrators: import the JSON format. `onConflict: "fail"` (default, `409 TEMPLATE_EXISTS`) or `"replace"`. |
| `GET /api/admin/templates/{id}/export` | A template as a downloadable JSON file; an export is a valid import. |

```bash
curl -s "$BASE/api/templates?industry=dental&limit=5" -H "authorization: Bearer $TOKEN"
curl -s -X POST "$BASE/api/templates/sales-page-bump-upsell/use" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Spring masterclass","bindings":{"main":{"create":true}}}'
curl -s "$BASE/api/admin/templates/lead-magnet/export" -H "authorization: Bearer $ADMIN_TOKEN" > lead-magnet.json
curl -s -X POST "$BASE/api/admin/templates/import" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data @lead-magnet.json
```

### Import rules

Each step document goes through the same pipeline as a page saved from the builder (`validateDoc`: allow-list rebuild, CSS and URL filters, derived forms and products) without script rights. At most 12 steps, 1.8 MB of step documents (the API body limit is 2 MB), 12 tags, 8 product slots; step paths must be valid and unique; every `slot` a checkout names must be declared and a checkout needs slots. Contrast problems are reported as non-blocking `warnings` in the answer. Slug, category slug (created when missing, from `categoryName`) and `version` come from the file; replacing bumps the version past the old one and marks the template `imported`. Audited (`admin.template.imported|replaced`).

## Quality gates (`server/test/templates.library.test.ts`)

For every template: valid and unique slugs and step paths, known kinds, native document already clean (cleaning changes nothing), exactly one `h1` per step, no scripts, remote images or CSS `url()`, every anchor resolves, images have alt text, no fixed width above 560px without a `max-width`, product slots match checkout blocks and their roles (bump, upsell, downsell), WCAG AA contrast for every explicit colour pairing. The contrast audit (`server/src/templates/contrast.ts`) follows the base stylesheet's theme rules (light, dark, accent, soft, cards, buttons) and checks each gradient stop; it is an approximation without a browser, and images and blended translucent colours are not audited. A sample run uses every template through the API and opens it as a native page. `e2e/shoot-templates.mts` renders template screenshots for design review.

## Gallery UI

`/templates` and the "From a template" tab of New funnel: category chips, industry and goal selects, "Has checkout", search, pages, real thumbnails (the page rendered at 1280px and scaled, lazily loaded), a preview in a sandboxed iframe (`sandbox=""`, no scripts) with a desktop, tablet and mobile toggle and per-step tabs, and the "Use this template" wizard: funnel name and, for templates with checkout steps, which products to bind (create the sample product, or pick one from the catalog).

## Limitations

Templates carry English copy. The contrast audit is not a browser. Thumbnails load one rendered page per card (ETag-cached); a very large library would want pre-rendered thumbnail images.
