# 0048. Product catalog block: rendered from the catalog, re-rendered on catalog changes

Status: Accepted

## Context

Owners with more than a few products asked for a grid that lists their catalog instead of one hand-placed Add to cart block per product. The grid must stay true to the catalog after the page is published (new products, changed prices, archived products), must sell through the existing server-side cart (ADR 0047: one currency per cart, the server is the only authority on prices, `add_to_cart` analytics and AddToCart conversions), and must work on every serving path: the stored page on the app origin and the built-in address, customer domains behind the edge cache, and static Cloudflare Pages bundles built at publish time.

Published pages are rendered once and stored (`step_pages.html`); serving never renders. The Google reviews block already takes a snapshot of server data at render time and the page refreshes it from a public endpoint.

## Decision

* **Block** `fn-catalog` (props `fnCatalog`): `source: all | picked` (picks are `{productId, priceId?}` or a template `slot`), `sort` (catalog order = oldest first, price low to high, price high to low, newest), `limit` (1 to 24), `columns` (1 to 4 on desktop; at most 2 below 992 px and 1 below 560 px), show image / description / price, button text, `action: add | buy` (`buy` adds, then goes to `checkoutStepId`, default the next step), an optional quantity selector, `then` after adding (stay, next step, a step) and `emptyText`.
* **What is listed**: active `one_time` products with an active one-time price, read by `loadCatalog` (services/catalogview.ts, at most 200 products plus any hand-picked ones). A card sells the picked price, the price that replaced it, else the product's default price. Subscriptions, archived products and archived prices are never listed. The markup is the shared `catalogInner` (server and builder canvas), escaped like every other block.
* **When the page reflects the catalog**: at render time. Every render reads the catalog snapshot: page save, regeneration, signed previews, and Cloudflare bundle builds. **Every catalog write through the products API** (create, edit, archive, restore, add, replace or archive a price) re-renders the funnels whose pages hold a Product catalog block (`refreshCatalogPages` → `regenerateFunnel`): the stored HTML changes, the page cache is invalidated and the edge purge is scheduled, so the built-in address and custom domains serve the catalog as it is now. For a funnel published to **Cloudflare Pages** (or the Workers target) the regeneration schedules the usual debounced redeploy (`onFunnelChanged`, reason `save`, not while the funnel is on hold), so the bundle holds the catalog **as it was when the bundle was built** and catches up with the next deployment.
* **Adding**: each card is an Add to cart form posting to the existing `/api/public/cart/{funnel}/{step}/{block}/add` with `productId` (from `data-product`). The server resolves the block from the stored page, checks the product against it (hand-picked: must be a pick; all: any listed product of the funnel's workspace), reads the price from the catalog and runs the unchanged add path (one currency per cart, line and quantity caps, idempotent `opId`, `add_to_cart` event, AddToCart conversion with the browser's event id). Nothing in the request or the page is a price.
* **Images**: products already had `images`; migration 045 adds `image_alt` (API `imageAlt`, Products editor), used as the card image's alt text (empty = decorative, the product name is the card heading). Card buttons are named "<button text>: <product name>".
* **Templates**: picks may name a template slot; using the template binds it to the chosen product; exporting a page as a template drops product ids (a catalog left with no pick lists all products).

## Alternatives considered

* **Render the grid in the browser from a public catalog endpoint.** Always current on every host, including Pages, but the cards would be empty without JavaScript and for crawlers, and a new public endpoint would list a workspace's catalog to anyone. Rejected; the static snapshot plus server-checked adds keeps pages complete and the API surface unchanged.
* **Render on every request (serve time) on the app origin.** Matches "current at serve time" literally, but serving never renders today (stored HTML, page cache, edge cache, CSP hashes computed from the stored page); re-rendering on catalog writes gives the same freshness without changing the serving path.
* **Snapshot at save only.** Simplest, but a price change would leave published grids wrong until the owner saved the page again.

## Consequences

* A catalog write costs one regeneration per funnel that holds the block (synchronous, in the products request); a workspace with many such funnels makes product edits slower. Products created implicitly by saving a Checkout or Add to cart block appear in grids on the next render (next catalog write, page save or publish).
* Between a catalog change and the next Cloudflare deployment a Pages grid can show an archived product or an old price; adding it is refused (`PRODUCT_UNAVAILABLE`) or priced from the catalog, and the cart and payment form always show catalog prices.
* "All products" may mix currencies; the one-currency-per-cart rule then refuses the second currency with its usual message.
