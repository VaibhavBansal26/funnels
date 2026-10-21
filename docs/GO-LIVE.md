# Going live

A funnel is in **test mode** until you put it live on an **address**. In test mode only people with your signed preview link can open it and nothing is counted. When it is live, anyone with the address can open it, and visits, leads and orders are recorded.

Funnel > Settings > **Go live** lists the addresses available to you:

| Address | Needs | Final URL |
|---|---|---|
| **Cloudflare Pages address (free)** | a connected Cloudflare account ([CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md)) | `https://<project>.pages.dev/<step path>` |
| **Cloudflare Workers address (free, experimental)** | a connected Cloudflare account with the Workers Scripts permission and a workers.dev subdomain | `https://<worker>.<subdomain>.workers.dev/<step path>` |
| **Your own domain** | a domain you added and verified (Domains page) | `https://offers.example.com/<step path>` |

Press **Go live**; the final URL is shown with **Copy link** and **Open**. **Take offline** returns the funnel to test mode (a Pages site is replaced by a paused page).

States shown next to the title: *Test mode*, *Publishing...* (a Cloudflare deployment is running), *Live*, *Publishing failed* (live is intended but nothing is online; fix the cause and press Try again), *Paused* (unpublished from Settings > Publishing).

API: `GET /api/funnels/{id}/addresses` (options, what is missing, state) and `POST /api/funnels/{id}/go-live` (`{address:{kind:"pages"}}`, `{address:{kind:"workers"}}` or `{address:{kind:"custom",domainId}}`). The raw `PATCH /api/funnels/{id}` with `status` and `domain_id` keeps working; `status: "live"` without an address is refused with `DOMAIN_NOT_ADDED`.

The Pages path is documented in [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md).
