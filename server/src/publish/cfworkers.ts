import { CloudflareApiError, type Envelope, type PagesCredentials } from './cfclient.js';

/**
 * Cloudflare Workers Static Assets client over an injectable `fetch`. EXPERIMENTAL AND UNVERIFIED: written from Cloudflare's documentation of the direct-upload flow and
 * checked only against `test/support/fakecf.ts`; never run against real Cloudflare. `scripts/cf-workers-smoke.ts` is how a person with a token checks it.
 *
 * Flow (https://developers.cloudflare.com/workers/static-assets/direct-upload/, read 2026-10-21):
 *  1. POST /accounts/{id}/workers/scripts/{name}/assets-upload-session   { manifest: { "/path": { hash, size } } }  ->  { jwt, buckets: [[hash...]] }
 *     (no buckets: nothing to upload, the jwt is already the completion token)
 *  2. POST /accounts/{id}/workers/assets/upload?base64=true   multipart/form-data, one part per file named by its hash, base64 body, the part's Content-Type is what is served;
 *     Bearer = the upload jwt; one request per bucket. The last answers 201 with { jwt } = completion token.
 *  3. PUT  /accounts/{id}/workers/scripts/{name}   multipart/form-data: part `metadata` { main_module, compatibility_date, assets: { jwt, config } } and the module part.
 *     This is `wrangler deploy`'s upload; whether the version it creates is deployed to 100% by the PUT itself is NOT stated by the page. The client therefore reads
 *     GET .../deployments afterwards and, when the newest deployment does not carry the new version, creates one (POST .../deployments { strategy: "percentage", versions: [{ version_id, percentage: 100 }] }).
 *  4. POST /accounts/{id}/workers/scripts/{name}/subdomain   enables <name>.<account subdomain>.workers.dev   (the request body is not documented: { enabled: true } is assumed)
 *  GET /accounts/{id}/workers/subdomain -> { subdomain }: the account's workers.dev subdomain; PUT creates it. Without one there is no workers.dev address.
 * Limits (https://developers.cloudflare.com/workers/platform/limits/): 100 Workers per account on Free (500 Paid), 20,000 static asset files per Worker version on Free
 * (100,000 Paid), 25 MiB per file.
 */
export interface WorkersFile {
  /** `/index.html` (the manifest key) */
  path: string;
  /** Pages/Wrangler asset hash, 32 hex (publish/hash.ts) */
  hash: string;
  size: number;
  bytes: Uint8Array;
  contentType: string;
}

export interface WorkersDeployment {
  id: string;
  versionId: string | null;
  createdOn: string | null;
}

export const WORKERS_SCRIPT_LIMIT_FREE = 100;
/** The module that fronts the assets: everything is answered by the static assets, anything else is a 404. */
export const ASSETS_ONLY_MODULE = 'export default { async fetch() { return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }); } };\n';
export const COMPATIBILITY_DATE = '2025-09-01';

export class CloudflareWorkersClient {
  private f: typeof fetch;
  constructor(
    private creds: PagesCredentials,
    fetchImpl: typeof fetch = fetch,
    private timeoutMs = 30_000,
  ) {
    this.f = fetchImpl;
  }

  private base = () => this.creds.base.replace(/\/$/, '');
  private acct = (p: string) => `${this.base()}/accounts/${encodeURIComponent(this.creds.accountId)}/workers${p}`;
  private script = (name: string, p = '') => this.acct(`/scripts/${encodeURIComponent(name)}${p}`);

  private async call<T>(method: string, url: string, opts: { token?: string; json?: unknown; form?: FormData } = {}): Promise<Envelope<T> & { status: number }> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? this.creds.token}` };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    let res: Response;
    try {
      res = await this.f(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new CloudflareApiError(0, null, `Could not reach Cloudflare: ${(e as Error).name === 'TimeoutError' ? 'the request timed out' : (e as Error).message.slice(0, 120)}`);
    }
    const text = await res.text();
    let env: Envelope<T> | null = null;
    try {
      env = text ? (JSON.parse(text) as Envelope<T>) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok || env?.success === false) {
      const first = env?.errors?.[0];
      const retry = Number(res.headers.get('retry-after'));
      throw new CloudflareApiError(res.status || 502, first?.code ?? null, first?.message ?? `Cloudflare answered HTTP ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return { ...(env ?? { success: true }), status: res.status };
  }

  /** A read call that proves the token can reach Workers scripts of the account. */
  async verify(): Promise<{ scripts: number }> {
    const r = await this.call<unknown[]>('GET', `${this.acct('/scripts')}`);
    return { scripts: Array.isArray(r.result) ? r.result.length : 0 };
  }

  /** Number of Workers in the account (the Free plan allows 100). */
  async countScripts(): Promise<number> {
    const r = await this.call<unknown[]>('GET', this.acct('/scripts'));
    return Array.isArray(r.result) ? r.result.length : 0;
  }

  /** The account's workers.dev subdomain, or null when none is registered (every workers.dev address needs one). */
  async accountSubdomain(): Promise<string | null> {
    try {
      const r = await this.call<{ subdomain?: string }>('GET', this.acct('/subdomain'));
      return r.result?.subdomain || null;
    } catch (e) {
      if (e instanceof CloudflareApiError && (e.notFound || e.code === 10007)) return null;
      throw e;
    }
  }

  async scriptExists(name: string): Promise<boolean> {
    try {
      await this.call('GET', this.script(name, '/settings'));
      return true;
    } catch (e) {
      if (e instanceof CloudflareApiError && e.notFound) return false;
      throw e;
    }
  }

  async deleteScript(name: string): Promise<void> {
    await this.call('DELETE', `${this.script(name)}?force=true`);
  }

  async enableWorkersDev(name: string): Promise<void> {
    await this.call('POST', this.script(name, '/subdomain'), { json: { enabled: true, previews_enabled: false } });
  }

  /** Steps 1 to 3: registers the manifest, uploads what Cloudflare lacks and uploads the script version carrying the assets. Returns the new version's deployment. */
  async deploy(name: string, files: WorkersFile[], message?: string): Promise<WorkersDeployment> {
    const manifest = Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]));
    const session = await this.call<{ jwt?: string; buckets?: string[][] }>('POST', this.script(name, '/assets-upload-session'), { json: { manifest } });
    let jwt = session.result?.jwt ?? '';
    if (!jwt) throw new CloudflareApiError(502, null, 'Cloudflare returned no upload token');
    const byHash = new Map(files.map((f) => [f.hash, f]));
    for (const bucket of session.result?.buckets ?? []) {
      const form = new FormData();
      for (const h of bucket) {
        const f = byHash.get(h);
        if (!f) continue;
        form.set(h, new Blob([Buffer.from(f.bytes).toString('base64')], { type: f.contentType }), h);
      }
      const up = await this.call<{ jwt?: string | null }>('POST', `${this.base()}/accounts/${encodeURIComponent(this.creds.accountId)}/workers/assets/upload?base64=true`, { token: jwt, form });
      if (up.result?.jwt) jwt = up.result.jwt; // the last bucket answers with the completion token
    }
    const meta = {
      main_module: 'index.js',
      compatibility_date: COMPATIBILITY_DATE,
      assets: { jwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
      ...(message ? { annotations: { 'workers/message': message.slice(0, 200) } } : {}),
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata');
    form.set('index.js', new Blob([ASSETS_ONLY_MODULE], { type: 'application/javascript+module' }), 'index.js');
    const before = await this.latestDeployment(name).catch(() => null);
    await this.call('PUT', this.script(name), { form });
    let latest = await this.latestDeployment(name);
    if (!latest || latest.id === before?.id) {
      // The upload did not deploy by itself: take the newest version and send 100% of traffic to it.
      const newest = await this.newestVersion(name);
      if (newest) latest = await this.rollback(name, newest);
    }
    return latest ?? { id: name, versionId: null, createdOn: null };
  }

  /** GET .../versions: newest first (the shape `result.items[].id` follows the API reference; unverified). */
  async newestVersion(name: string): Promise<string | null> {
    const r = await this.call<{ items?: { id: string }[] }>('GET', this.script(name, '/versions'));
    return r.result?.items?.[0]?.id ?? null;
  }

  async latestDeployment(name: string): Promise<WorkersDeployment | null> {
    const r = await this.call<{ deployments?: { id: string; created_on?: string; versions?: { version_id: string; percentage: number }[] }[] }>('GET', this.script(name, '/deployments'));
    const d = r.result?.deployments?.[0];
    return d ? { id: d.id, versionId: d.versions?.find((v) => v.percentage === 100)?.version_id ?? d.versions?.[0]?.version_id ?? null, createdOn: d.created_on ?? null } : null;
  }

  /** Makes an earlier version the one serving 100% of traffic. */
  async rollback(name: string, versionId: string): Promise<WorkersDeployment> {
    const r = await this.call<{ id: string; created_on?: string }>('POST', this.script(name, '/deployments'), { json: { strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': 'rollback from Funnels' } } });
    return { id: r.result?.id ?? versionId, versionId, createdOn: r.result?.created_on ?? null };
  }
}
