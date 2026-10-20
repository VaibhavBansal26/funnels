# 0022. Page builder on GrapesJS: project JSON as the source of truth, server-rendered sanitised HTML

Status: Accepted. Supersedes the "Page model" decision of the first build (a versioned block document with a custom renderer and a custom drag-and-drop outline editor).

## Context

The first build stored each page as a typed block document, rendered it with its own renderer and edited it through a form-style inspector and an outline list. In use it fell short in three ways: it was not a canvas editor (nothing could be dragged onto the page, only reordered in a list), its look was plain, and some pages rendered dark text on dark sections. The legacy product it replaced was a GrapesJS editor with a rich block library and per-element settings, but it stored client-rendered HTML that the server trusted.

Requirements for the rebuild: true drag and drop on the canvas (blocks in, reorder, nest, resize, inline text editing, multi-select, keyboard), a professional interface that works from 1024 px up, the data model must stay safe (no stored XSS, prices and forms decided by the server, scripts only for permitted users), existing pages and the AI generator must keep working, and every existing test suite must stay green.

## Decision

1. **GrapesJS** (npm `grapesjs`, version pinned, loaded as a lazy chunk) is the canvas and the document model, with all of its own panels disabled. The interface (top bar, Blocks, Layers, Pages, Images, Inspector, dialogs) is React with Radix primitives and Tailwind, talking to the editor through its API and events. The canvas is GrapesJS's iframe, so dragging, nesting, resizing and inline editing are real canvas interactions rather than imitations.
2. **The GrapesJS project JSON is the source of truth** (`step_pages.doc_json`, `{ version: 2, project, forms, products }`). The browser sends project JSON and nothing else. The server rebuilds it from allow-lists (`cleanProject`), derives `forms` and `products` from typed component props, renders the page itself (`renderProject`) and runs `sanitize-html` and `postcss` over the result. HTML and CSS are never accepted from the client and never trusted.
3. **One shared pure module** (`server/src/pagemodel/shared`, imported by the web app as `@pagemodel`) holds the allow-lists, the typed props, the markup of dynamic components, the base page CSS and the DSL that builds blocks and templates. The editor canvas, the validator the editor runs before saving and the publisher therefore agree by construction.
4. **Dynamic components are typed**: forms, checkouts (offer, bump, one-click upsell), video, countdown, progress bar, custom code and button actions keep their behaviour in one validated prop each. Custom code exists only for the owner of a workspace that enables scripts; the server enforces it, the UI only hides it.
5. **A deterministic converter** turns old block documents into projects (same input, same output, never throws, keeps form and checkout ids so published forms and orders stay valid). Stored pages and template steps are converted once at start-up with the original kept in `legacy_doc_json`; backups convert on read. The seeded templates are authored natively; the AI funnel generator still produces block documents and relies on the converter.
6. **A design system** replaces the ad-hoc stylesheet for the whole web app: Tailwind v4 tokens with light and dark sets, Radix-based components in `web/src/ui/`, lucide icons, WCAG AA contrast checked by a test.
7. **Behaviour was taken from the legacy builder, code was not** ([PROVENANCE.md](../PROVENANCE.md)): the component model, drop rules, block catalogue, settings, commands, style sections, outline colours and the component-version idea, re-implemented against the npm package; no credentials, hosts or brand names carried over.

## Alternatives considered

* **Keep the block document and write the drag and drop ourselves.** Full control and a tiny bundle, but a canvas editor is mostly the hard part (hit testing inside an iframe, placeholders, nesting rules, text editing, resize handles); doing it well is a larger project than adopting GrapesJS and would not reuse the legacy block and settings knowledge.
* **Store client-rendered HTML like the legacy product, with a sanitiser on top.** Simplest data flow, and the one with the weakest guarantees: forms and prices would have to be recovered from HTML, and every sanitiser gap is a stored XSS. Deriving `forms` and `products` from typed props and rendering on the server removes that class of bug.
* **Another editor framework (Craft.js, Puck, Builder.io SDK, Editor.js).** Each fits a different problem (component trees in React, block editors for articles); none gives the Section > Row > Column model, device-aware CSS rules and a canvas iframe we already knew from the legacy product.
* **Sandbox the whole editor in a cross-origin iframe.** Strong isolation, but the editor needs the app's session and API; the canvas CSP (no script, no frames) plus cleaning the project before load gives the same guarantee for page content at a fraction of the complexity.
* **Use `@grapesjs/react`.** Peer range `^0.22.5` excludes 0.23.x, and every panel is custom anyway.

## Consequences

* The builder chunk is about 370 KB gzip (GrapesJS is 294 KB of it) and loads only on the builder route; the bundle budget was raised for it and is enforced in the build ([PERFORMANCE.md](../PERFORMANCE.md)).
* We depend on GrapesJS internals at a pinned version (0.23.8): for example `Component.move` takes an index in the *current* list (insertBefore semantics), the toolbar and RTE markup are theirs, and an upgrade needs the Playwright suite as its safety net. The first synthetic drag after load is ignored unless the pointer has crossed the canvas once; we have not seen it by hand and it is handled in the test helper, not in the app.
* Page size is bounded (3,000 components, depth 24, 2 MB) because a project carries per-id CSS rules; a legacy page that cannot be converted within the limits is replaced by an empty page (a warning is logged with the step id) and its original stays in `legacy_doc_json`, so nothing is lost but the page must be rebuilt.
* Allow-lists are code we maintain: a new CSS property or tag is refused until added (the XSS corpus and `cssvalues.ts` are where to add and prove it).
* Touch devices cannot drag blocks from the panel (HTML5 drag events do not fire); click-to-insert and the Layers panel are the touch path, and below 768 px a notice says the builder works best on a larger screen.
* Migration is irreversible in practice (the original is kept in `legacy_doc_json` but nothing converts back); the converter is tested on every block type, every AI step kind and every seeded template.
