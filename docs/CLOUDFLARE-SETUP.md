# Cloudflare setup, step by step

For someone who has never used Cloudflare. About ten minutes. **Status: the app's Cloudflare code has only been tested against a fake that follows Cloudflare's documentation; it has never talked to the real Cloudflare** (nobody has given the project a token). Step 6 runs the check that proves it on your account. Screens and labels in the dashboard change from time to time; if a name below differs, look for the closest one. Last checked against Cloudflare's documentation on 2026-10-21.

**Never paste an API token into a chat, an issue, a commit, a screenshot or a file in the repository.** Anyone with the token can publish to and delete things in your Cloudflare account. If you did, delete the token (step 3 backwards) and make a new one.

## 1. A free Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up>, sign up with an email and a password, confirm the email.
2. You do not need to add a website or a domain. Skip any "add a site" prompt.

## 2. Find your Account ID

1. In the dashboard, open **Workers & Pages** in the left sidebar.
2. On the overview page look at the right-hand column: **Account ID** with a copy button. (The same 32 characters are in the address bar: `dash.cloudflare.com/<account id>/...`.)
3. It is 32 letters and digits, for example `0123456789abcdef0123456789abcdef`. The Account ID is an identifier, not a secret.

## 3. Create a scoped API token

1. Click your profile icon (top right) > **My Profile** > **API Tokens** > **Create Token**.
2. Next to **Create Custom Token** click **Get started**.
3. Token name: `funnels-publish`.
4. Permissions, add these rows (each row is *scope | resource | level*):
   * **Account** | **Cloudflare Pages** | **Edit**
   * **Account** | **Account Settings** | **Read**
   * only if you want the experimental Workers option: **Account** | **Workers Scripts** | **Edit**
5. Account Resources: **Include** > **Specific account** > choose your account. (Do not choose *All accounts* or add Zone permissions: the app never needs them.)
6. Optional but wise: set **TTL** (an end date), and **Client IP address filtering** if the app runs from a fixed address.
7. **Continue to summary** > **Create Token**. Cloudflare shows the token **once**. Copy it now.

## 4. Paste it into the app

1. Settings > **Publishing** (the card lists the same steps) > enter **Account id** and **API token** > **Connect**.
2. The app checks them with a read call and shows the token masked (`••••` and the last four characters). If you see an error:

| Message | What it means | What to do |
|---|---|---|
| "Cloudflare refused the token. Check the account id and give the API token the permission Cloudflare Pages: Edit" | The token is wrong, expired, or missing the permission, or the Account ID belongs to another account. | Re-check step 2 and 3; make a new token if unsure. |
| "Cloudflare is rate limiting this account" | Too many API calls in a short time. | Wait a minute; the app retries by itself. |
| "This Cloudflare account has reached its limit of 100 Pages projects" | Cloudflare allows 100 Pages projects per account and this app creates one per funnel. | Delete projects you do not need: Workers & Pages > the project > Settings > Delete; or use the built-in address for that funnel; or connect another account. |
| "Cloudflare limits how many Pages projects a new account can create in its first 48 hours" | Anti-abuse limit on new accounts. | Wait 48 hours, or publish from this server meanwhile. |
| "The domain ... also serves other live funnels" | A Pages project serves one funnel per domain. | Give each funnel its own domain (or use the free pages.dev addresses). |

## 5. Publish: no domain needed

1. In the builder press **Publish** (or open the funnel > **Settings** > **Go live**).
2. Choose **Cloudflare Pages address (free)** and press **Go live**. The app creates a project, uploads the pages and shows **Publishing...**, then **Live** with the address, for example `https://fn-1a2b3c4d.pages.dev/your-page`. Use **Copy link** or **Open**.
3. If it shows **Publishing failed**, open Settings > Publishing > the deployment log, read the message, fix it and press **Try again**.
4. **Roll back / remove.** Settings > Publishing > Deployment history > **Roll back** on an earlier version. **Unpublish** pauses the site (a "not available" page) or deletes the project (frees one of your 100). **Take offline** in Go live returns the funnel to test mode.

Free plan limits that matter (Cloudflare, read 2026-10-21): 100 Pages projects per account, 20,000 files per site, 25 MiB per file, 100 custom domains per project. Direct Upload deployments are not limited by the 500 builds per month that apply to Git builds.

## 6. Prove it with the smoke script (recommended once)

The script creates a throwaway project, deploys two tiny sites, fetches them over the internet, rolls back, and deletes everything it created. It reads the token **only from the environment**, never prints it, and uses 1 of your 100 projects while it runs.

```bash
cd server
export CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef      # CLOUDFLARE_ACCOUNT_ID works too
export CF_API_TOKEN=...        # CLOUDFLARE_API_TOKEN works too; type it into your own terminal, never into a chat
npx tsx scripts/cf-pages-smoke.ts      # Pages
npx tsx scripts/cf-workers-smoke.ts    # experimental Workers option, if you gave the token Workers Scripts: Edit
unset CF_API_TOKEN
```

It prints one line per step and a summary. A failing step is a bug in the app's Cloudflare code or a wrong assumption in the fake: please report the step name and the message (without the token).
