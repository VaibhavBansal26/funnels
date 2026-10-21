# Going live

A funnel is in **test mode** until you put it live on an **address**. In test mode only people with your signed preview link can open it and nothing is counted. When it is live, anyone with the address can open it, and visits, leads and orders are recorded.

## In one minute (no domain, no account)

1. In the builder press **Publish** (or open a funnel > **Settings** > **Go live**).
2. Keep **Built-in address (free)** selected and press **Go live**.
3. The final URL appears, for example `https://your-app.onrender.com/s/acme/free-guide/free-guide`. **Copy link** or **Open** it. Done.

## Publishing from the builder

The **Publish** button in the builder's top bar does the whole job without leaving the editor. It shares its code with the Go live card in Settings (`web/src/components/GoLive.tsx`), so both show the same choices and do the same calls.

1. **Unsaved changes are saved first**, as soon as the dialog opens (with a backup, like Save). If the save fails (for example the page was changed in another tab), the dialog says so, says that nothing was published, and offers **Retry save**; **Go live** stays off until the page is saved.
2. **Choose the address.** Each option shows its real final URL. *Built-in address (free)* is preselected when nothing else is configured. *Cloudflare Pages address (free)* needs a connected Cloudflare account: when there is none it is disabled and says **Connect Cloudflare first**, with a link (opens in a new tab, so the builder keeps your work) to **Settings > Publishing**, where you enter the Account id and an API token with the **Cloudflare Pages: Edit** permission ([CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md)); come back and the option is enabled (the list refreshes when the tab gets focus). *Cloudflare Workers address* is marked **Experimental**. Verified custom domains are listed too. The address name, the search engine switch and custom domains are managed in the funnel's Settings.
3. **Go live** performs the go-live in one step (`POST /api/funnels/{id}/go-live`). The badge shows *Publishing...* while Cloudflare deploys (the dialog follows it), then *Live* with the final URL, **Copy link** and **Open**. If publishing fails the dialog shows the server's message and **Retry** redeploys.
4. **When it is already live** the dialog is titled *Publish changes* and shows where it is served, the publish state, **Update live page** and **Take offline**. *Update live page* saves the page and, on a Cloudflare address, queues a redeploy right away (`POST /api/funnels/{id}/publishing/redeploy`, needs `publishing:manage`; without it the debounced deployment that every save schedules still runs). On the built-in address or a custom domain a save is already served within seconds.
5. **Open preview** is always there: it opens the signed preview of the saved page and counts no visit.

Accessibility: the dialog traps the focus, closes on Escape and returns the focus to the Publish button; the save, publish and error messages are announced (`role="status"` / `role="alert"`). Screenshots: [test mode 1440 light](design/publish-dialog-test-mode-1440-light.webp), [Pages chosen 1024 dark](design/publish-dialog-pages-chosen-1024-dark.webp), [live 390 light](design/publish-dialog-live-390-light.webp).

Test vs live (one sentence, the same in the builder and in Settings): while the funnel is in test mode the page is only reachable through the signed preview and no visit is counted. Once live, anyone with the link can open it. **Take offline** puts it back in test mode.

## The addresses

| Address | Needs | Final URL |
|---|---|---|
| **Built-in address (free)** | nothing | `<APP_PUBLIC_URL>/s/<workspace name>/<funnel name>/<step path>` |
| **Cloudflare Pages address (free)** | a connected Cloudflare account ([CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md)) | `https://<project>.pages.dev/<step path>` |
| **Cloudflare Workers address (free, experimental)** | a connected Cloudflare account with the Workers Scripts permission and a workers.dev subdomain | `https://<worker>.<subdomain>.workers.dev/<step path>` |
| **Your own domain** | a domain you added and verified (Domains page) | `https://offers.example.com/<step path>` |

States shown next to the title: *Test mode*, *Publishing...* (a Cloudflare deployment is running), *Live*, *Publishing failed* (live is intended but nothing is online; fix the cause and press Try again), *Paused* (unpublished from Settings > Publishing).

## The built-in address

* **Scheme.** `/s/<workspace>/<funnel>/<step path>`. The workspace name (slug) is made from the workspace name the first time it is needed and the funnel name from the funnel name; both are lower-case letters, digits and single hyphens (1 to 40 characters), unique (per workspace for funnels, globally for workspaces; a collision gets `-2`, `-3`). **Renaming the funnel or workspace does not change them.** Change the funnel's *Address name* in Go live, or the workspace's with `PATCH /api/workspace {"slug": "..."}`; the old address stops working (there is no redirect) and every page of the funnel is re-rendered with the new links.
* **The funnel root.** `/s/<workspace>/<funnel>/` serves the step whose path is `/`, or the first step when none is. `/s/<workspace>/<funnel>` redirects to the slash form. Case and trailing-slash variants of a step path redirect (301) to the stored path under the prefix.
* **Links are rewritten from step ids at render time**, not by text replacement: the renderer is given each step's href (`/s/<workspace>/<funnel>` + the step path), so next-step and go-to-step buttons, form success actions and one-click-offer routes all stay inside the prefix; the page also carries `<link rel="canonical">` with the full URL. The same funnel on a custom domain is rendered without the prefix, and its stored HTML is regenerated whenever the address, a slug, or the workspace slug changes.
* **Forms, checkout, events and the beacon stay at the root** (`/api/public/...`, `/beacon.js`): a page on the app's own host calls the app same-origin. Stripe checkout success and cancel URLs return to the prefixed address; the server-side conversion events report it as the page URL.
* **Cookies** (`visitor_id`, `funnel_id`, `step_id`, `utm_*`) are scoped to `Path=/s/<workspace>`: another workspace's page on the same host can neither read nor set them.
* **Search engines.** Built-in addresses answer `X-Robots-Tag: noindex, nofollow` unless the funnel's *Let search engines index this address* is on (`PATCH /api/funnels/{id} {"allow_indexing": true}`).
* **Isolation.** Only a funnel that is **live** and attached to **its own workspace's** built-in address is served; a test funnel, a trashed one, one on another address, an unknown or mistyped name all answer the same 404 (no existence leak), and a suspended workspace answers 503. The app's own host cannot be registered as a customer domain, system domains have synthetic `.invalid` hostnames that no `Host` header can match, and the public pages are rate limited like pages on customer domains (`public.page`).
* **Pages with owner-authored code** (custom code blocks, tracking snippets, event-handler attributes) run on the app's origin, so they are served with `Content-Security-Policy: sandbox allow-scripts allow-forms ...` (an opaque origin): their scripts work, but they can not read the app's or other tenants' cookies, storage or session, and can not call the app's API as the signed-in user. The beacon falls back to in-memory ids when cookies are not readable. Pages without owner code get an exact CSP (the platform's own scripts by hash). Third-party pixels that need first-party cookies work only on pages without owner code; use a custom domain for production ad tracking.
* **Caching.** `ETag` is the page checksum, `Cache-Control: private, max-age=0, must-revalidate`, 304 on `If-None-Match`; the in-process page cache is keyed by step and cleared by every save. Behind the edge worker the cache key is the full URL including the prefix ([CLOUDFLARE.md](CLOUDFLARE.md)).
* **Preview parity.** The signed preview renders through the same code with its own link builder (`/preview/<funnel id>/...?token=`), so what the preview links to is what the built-in address links to, step for step.

## Moving between addresses

* Choosing the built-in address while the funnel is published to Cloudflare switches the target back to this server and pauses the Cloudflare site. Switching the target back yourself (Settings > Publishing) moves a live funnel to its built-in address, so it stays reachable.
* Choosing a Cloudflare address while live on the built-in address moves it there; the built-in address then stops answering.
* A verified custom domain can be chosen at any time. The Cloudflare Pages target keeps working with it (the project is then served at both addresses).

## API

`GET /api/funnels/{id}/addresses` (options, what is missing, state, the built-in names; it creates the workspace's built-in address record and the slugs the first time) and `POST /api/funnels/{id}/go-live` (`{address:{kind:"builtin"}}`, `{address:{kind:"pages"}}`, `{address:{kind:"workers"}}` or `{address:{kind:"custom",domainId}}`). The raw `PATCH /api/funnels/{id}` with `status`, `domain_id`, `public_slug` and `allow_indexing` keeps working; `status: "live"` without an address is refused with `DOMAIN_NOT_ADDED`.

The Cloudflare paths are documented in [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md).
