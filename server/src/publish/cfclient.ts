/**
 * Cloudflare Pages Direct Upload client over an injectable `fetch`. VERIFIED ONLY AGAINST THE DOCUMENTED API SHAPES WITH A FAKE (test/support/fakecf.ts); it has
 * never been run against real Cloudflare. `scripts/cf-pages-smoke.ts` is how a person with a token checks it (docs/CLOUDFLARE-PAGES.md).
 *
 * Endpoints (REST envelope `{ success, errors[{code,message}], messages[], result }`, `Authorization: Bearer <token>`):
 *  - GET    /accounts/{account_id}/pages/projects                              list (used to verify the token can read Pages)
 *           https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/
 *  - POST   /accounts/{account_id}/pages/projects                              create { name, production_branch }
 *           https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/
 *  - GET    /accounts/{account_id}/pages/projects/{project}                    get (result.subdomain is `<name>.pages.dev`)
 *  - DELETE /accounts/{account_id}/pages/projects/{project}                    delete (with all its deployments)
 *  - GET    /accounts/{account_id}/pages/projects/{project}/upload-token       result.jwt, scoped to the account and project
 *           https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/upload_token/ (hosted API reference lists it as GET)
 *  - POST   /pages/assets/check-missing   { hashes: [] }                       result: the hashes Cloudflare does not have yet; Bearer = the upload JWT
 *  - POST   /pages/assets/upload          [{ key, value, metadata:{contentType}, base64:true }]   Bearer = the upload JWT
 *  - POST   /pages/assets/upsert-hashes   { hashes: [] }                       records hashes as recently used so unchanged files are not uploaded again
 *           https://developers.cloudflare.com/api/resources/pages/subresources/assets/methods/upsert_hashes/
 *    (the three asset endpoints are not under /accounts/{id}: the JWT carries the account and project; the upload body shape and the hash algorithm are what
 *    Wrangler sends, see publish/hash.ts)
 *  - POST   /accounts/{account_id}/pages/projects/{project}/deployments        multipart/form-data: manifest (JSON path -> hash), branch, commit_message, commit_hash,
 *           commit_dirty, and the files _headers / _redirects. Result: deployment { id, short_id, url, environment, latest_stage{name,status}, stages[], aliases[] }
 *           https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/
 *  - GET    /accounts/{account_id}/pages/projects/{project}/deployments/{id}   status: poll latest_stage until deploy has status success or failure
 *  - POST   /accounts/{account_id}/pages/projects/{project}/deployments/{id}/rollback   makes an earlier successful deployment the production one
 *           https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/
 *  - DELETE /accounts/{account_id}/pages/projects/{project}/deployments/{id}?force=true
 *  - POST   /accounts/{account_id}/pages/projects/{project}/domains            { name }  -> domain { name, status: initializing|pending|active|deactivated|blocked|error,
 *           validation_data{method,status,error_message,txt_name,txt_value}, verification_data{status,error_message}, certificate_authority }
 *           https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/
 *  - GET    /accounts/{account_id}/pages/projects/{project}/domains/{name}     read a domain's status
 *  - DELETE /accounts/{account_id}/pages/projects/{project}/domains/{name}
 *
 * Limits (https://developers.cloudflare.com/pages/platform/limits/): 20,000 files per site on Free (100,000 on paid plans with Wrangler 4), 25 MiB per file, 100 projects
 * per account, 100 custom domains per project on Free, 100 `_headers` rules, 2,000 static `_redirects`.
 */
export class CloudflareApiError extends Error {
  constructor(
    public status: number,
    public code: number | null,
    message: string,
    public retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
  /** Worth another try: rate limited, a Cloudflare outage, or a network failure (status 0). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status === 408 || this.status >= 500;
  }
  /** Cloudflare refused the page/per_page of a list call (code 8000024). */
  get invalidListOptions(): boolean {
    return this.code === 8000024 || (this.status === 400 && /list options/i.test(this.message));
  }
  get rateLimited(): boolean {
    return this.status === 429;
  }
  /** Cloudflare refused to create another Pages project: the 100-projects-per-account limit (https://developers.cloudflare.com/pages/platform/limits/). The exact code and wording are not documented; this matches what is known and is UNVERIFIED against the real API. */
  get projectLimit(): boolean {
    return (this.status === 400 || this.status === 403 || this.status === 422 || this.status === 429) && (this.code === 8000027 || /project(s)? (limit|quota)|maximum (number )?of (pages )?projects|too many projects|limit of \d+ projects|reached .*projects/i.test(this.message));
  }
  /** New accounts may only create a few Pages projects in their first 48 hours (documented, with no number or error code). UNVERIFIED matching. */
  get newAccountLimit(): boolean {
    return /48 ?h(ou)?rs?|first 48|recently (created|registered)|new account|anti-?abuse/i.test(this.message);
  }
  /** The token is missing a permission or is not valid. */
  get permission(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get notFound(): boolean {
    return this.status === 404;
  }
}

export interface Envelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  messages?: unknown[];
  result?: T;
}

export interface PagesProject {
  name: string;
  subdomain: string;
  production_branch?: string;
  domains?: string[];
  created_on?: string;
}

export interface PagesStage {
  name: string;
  status: 'idle' | 'active' | 'success' | 'failure' | 'canceled' | 'skipped' | string;
  started_on?: string | null;
  ended_on?: string | null;
}

export interface PagesDeployment {
  id: string;
  short_id?: string;
  url?: string;
  environment?: 'production' | 'preview';
  latest_stage?: PagesStage;
  stages?: PagesStage[];
  aliases?: string[] | null;
  created_on?: string;
}

export type DomainStatus = 'initializing' | 'pending' | 'active' | 'deactivated' | 'blocked' | 'error';
export interface PagesDomain {
  name: string;
  status: DomainStatus;
  certificate_authority?: string;
  validation_data?: { method?: string; status?: string; error_message?: string; txt_name?: string; txt_value?: string };
  verification_data?: { status?: string; error_message?: string };
}

export interface UploadFile {
  /** Pages asset hash (publish/hash.ts). */
  hash: string;
  base64: string;
  contentType: string;
}

export interface DeploymentFiles {
  manifest: Record<string, string>;
  headers?: string;
  redirects?: string;
  branch?: string;
  commitMessage?: string;
  commitHash?: string;
}

export interface PagesCredentials {
  accountId: string;
  token: string;
  base: string;
}

/** Splits files into upload batches of at most `maxFiles` files and `maxBytes` of base64 (Wrangler uses 5,000 files / 50 MiB; smaller batches here keep a request well under the timeout). */
export function batches(files: UploadFile[], maxFiles = 500, maxBytes = 20 * 1024 * 1024): UploadFile[][] {
  const out: UploadFile[][] = [];
  let cur: UploadFile[] = [];
  let size = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= maxFiles || size + f.base64.length > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += f.base64.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export class CloudflarePagesClient {
  private f: typeof fetch;
  constructor(
    private creds: PagesCredentials,
    fetchImpl: typeof fetch = fetch,
    private timeoutMs = 30_000,
  ) {
    this.f = fetchImpl;
  }

  private base = () => this.creds.base.replace(/\/$/, '');
  private acct = (p: string) => `${this.base()}/accounts/${encodeURIComponent(this.creds.accountId)}/pages${p}`;

  private async call<T>(method: string, url: string, opts: { token?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
    const env = await this.callRaw<T>(method, url, opts);
    return (env?.result ?? (env as unknown as T)) as T;
  }

  private async callRaw<T>(method: string, url: string, opts: { token?: string; json?: unknown; form?: FormData } = {}): Promise<Envelope<T>> {
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
      // The message of a fetch failure can include the URL (never a token: it is in a header), but keep it short and generic.
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
    return (env ?? ({ success: true } as Envelope<T>));
  }

  /** A read call that needs the "Cloudflare Pages: Read" (or Edit) permission: proves the token and account id are valid. It cannot prove write access; the first deployment does. */
  async verify(): Promise<{ projects: number }> {
    const r = await this.call<PagesProject[]>('GET', `${this.acct('/projects')}?per_page=1`);
    return { projects: Array.isArray(r) ? r.length : 0 };
  }

  /**
   * How many Pages projects the account has, counted through the API (the limit is 100 per account). Reads `result_info.total_count` when the answer carries it and
   * otherwise pages through the list. A cheap call; it runs before every project creation so the 101st project is refused with a clear message instead of a vague 400.
   */
  async countProjects(): Promise<number> {
    // Cloudflare caps per_page below the 100 we first assumed: a real account answered 400 (code 8000024, "Invalid list options provided")
    // for per_page=100 while per_page=1 worked, and the cap of this endpoint is not documented. Step down until a size is accepted.
    let rejected: unknown;
    for (const perPage of [100, 50, 25, 10, 5, 1]) {
      try {
        return await this.countWithPageSize(perPage);
      } catch (e) {
        if (e instanceof CloudflareApiError && e.invalidListOptions) {
          rejected = e;
          continue;
        }
        throw e;
      }
    }
    throw rejected;
  }

  private async countWithPageSize(perPage: number): Promise<number> {
    let total = 0;
    for (let page = 1; page <= 200; page++) {
      const env = await this.callRaw<PagesProject[]>('GET', `${this.acct('/projects')}?per_page=${perPage}&page=${page}`);
      const n = Array.isArray(env.result) ? env.result.length : 0;
      const info = (env as Envelope<unknown> & { result_info?: { total_count?: number } }).result_info;
      if (typeof info?.total_count === 'number') return info.total_count;
      total += n;
      if (n < perPage) return total;
    }
    return total;
  }

  getProject(name: string): Promise<PagesProject> {
    return this.call('GET', this.acct(`/projects/${encodeURIComponent(name)}`));
  }
  createProject(name: string, productionBranch = 'main'): Promise<PagesProject> {
    return this.call('POST', this.acct('/projects'), { json: { name, production_branch: productionBranch } });
  }
  async deleteProject(name: string): Promise<void> {
    await this.call('DELETE', this.acct(`/projects/${encodeURIComponent(name)}`));
  }

  async uploadToken(project: string): Promise<string> {
    const r = await this.call<{ jwt: string }>('GET', this.acct(`/projects/${encodeURIComponent(project)}/upload-token`));
    if (!r?.jwt) throw new CloudflareApiError(502, null, 'Cloudflare returned no upload token');
    return r.jwt;
  }
  async checkMissing(jwt: string, hashes: string[]): Promise<string[]> {
    if (!hashes.length) return [];
    const r = await this.call<string[]>('POST', `${this.base()}/pages/assets/check-missing`, { token: jwt, json: { hashes } });
    return Array.isArray(r) ? r : [];
  }
  async upload(jwt: string, files: UploadFile[]): Promise<void> {
    await this.call('POST', `${this.base()}/pages/assets/upload`, { token: jwt, json: files.map((f) => ({ key: f.hash, value: f.base64, metadata: { contentType: f.contentType }, base64: true })) });
  }
  async upsertHashes(jwt: string, hashes: string[]): Promise<void> {
    await this.call('POST', `${this.base()}/pages/assets/upsert-hashes`, { token: jwt, json: { hashes } });
  }

  createDeployment(project: string, d: DeploymentFiles): Promise<PagesDeployment> {
    const form = new FormData();
    form.set('manifest', JSON.stringify(d.manifest));
    form.set('branch', d.branch ?? 'main');
    if (d.commitHash) form.set('commit_hash', d.commitHash);
    if (d.commitMessage) form.set('commit_message', d.commitMessage.slice(0, 200));
    form.set('commit_dirty', 'false');
    if (d.headers) form.set('_headers', new Blob([d.headers], { type: 'text/plain' }), '_headers');
    if (d.redirects) form.set('_redirects', new Blob([d.redirects], { type: 'text/plain' }), '_redirects');
    return this.call('POST', this.acct(`/projects/${encodeURIComponent(project)}/deployments`), { form });
  }
  getDeployment(project: string, id: string): Promise<PagesDeployment> {
    return this.call('GET', this.acct(`/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}`));
  }
  rollback(project: string, id: string): Promise<PagesDeployment> {
    return this.call('POST', this.acct(`/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}/rollback`));
  }
  async deleteDeployment(project: string, id: string, force = false): Promise<void> {
    await this.call('DELETE', `${this.acct(`/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}`)}${force ? '?force=true' : ''}`);
  }

  addDomain(project: string, name: string): Promise<PagesDomain> {
    return this.call('POST', this.acct(`/projects/${encodeURIComponent(project)}/domains`), { json: { name } });
  }
  getDomain(project: string, name: string): Promise<PagesDomain> {
    return this.call('GET', this.acct(`/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(name)}`));
  }
  async deleteDomain(project: string, name: string): Promise<void> {
    await this.call('DELETE', this.acct(`/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(name)}`));
  }
}

/** The state of a deployment from its stages: `deploy` succeeded is live; any failed or canceled stage is failed; else still running. */
export function deploymentState(d: PagesDeployment): { state: 'running' | 'succeeded' | 'failed'; message: string | null } {
  const stages = d.stages ?? (d.latest_stage ? [d.latest_stage] : []);
  const bad = stages.find((s) => s.status === 'failure' || s.status === 'canceled');
  if (bad) return { state: 'failed', message: `Cloudflare reports the ${bad.name} stage as ${bad.status}` };
  const deploy = stages.find((s) => s.name === 'deploy');
  if (deploy?.status === 'success') return { state: 'succeeded', message: null };
  return { state: 'running', message: null };
}

/** Maps a domain's reported status to ours. */
export function domainState(d: PagesDomain): { status: 'pending' | 'active' | 'failed'; error: string | null } {
  if (d.status === 'active') return { status: 'active', error: null };
  const err = d.validation_data?.error_message || d.verification_data?.error_message || null;
  if (d.status === 'error' || d.status === 'blocked' || d.status === 'deactivated') return { status: 'failed', error: err ?? `Cloudflare reports the domain as ${d.status}` };
  return { status: 'pending', error: err };
}
