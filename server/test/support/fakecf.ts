import { pagesHash } from '../../src/publish/hash.js';

/**
 * An in-memory Cloudflare Pages that implements exactly the endpoints publish/cfclient.ts calls, with the response shapes of the documentation. It also behaves like
 * the real thing where a client can trip: asset hashes must have been uploaded before a deployment names them, a file whose hash does not match its content is accepted but
 * never served, projects have unique names, domains go through pending states, tokens may lack the write permission, and any endpoint can be told to fail or rate limit.
 * It proves the client and the deployment state machine against the documented shapes, NOT against Cloudflare.
 */
type Json = Record<string, unknown>;
export interface FakeDeployment {
  id: string;
  project: string;
  manifest: Record<string, string>;
  headers: string;
  redirects: string;
  environment: 'production' | 'preview';
  polls: number;
  createdOn: string;
  failStage: string | null;
  promoted: boolean;
}
interface FakeProject {
  name: string;
  subdomain: string;
  domains: Map<string, { polls: number }>;
  deployments: FakeDeployment[];
  production: string | null;
}

interface FakeVersion {
  id: string;
  manifest: Record<string, string>;
}
interface FakeWorkerDeployment {
  id: string;
  versions: { version_id: string; percentage: number }[];
  created_on: string;
}
interface FakeWorker {
  name: string;
  versions: FakeVersion[];
  deployments: FakeWorkerDeployment[];
  live: string | null;
  workersDev: boolean;
}

export class FakeCloudflarePages {
  accountId = 'a'.repeat(32);
  token = 'cf-test-token-0123456789abcdef';
  canWrite = true;
  canRead = true;
  projects = new Map<string, FakeProject>();
  /** The real list-projects call answered 400 (code 8000024) for per_page=100 on a real account while per_page=1 worked; the exact cap is undocumented, so the fake uses 10. */
  maxPerPage = 10;
  /** Make every list-projects call fail with this status/code (null = behave normally). */
  failList: { status: number; code: number; message: string } | null = null;
  assets = new Map<string, { bytes: Buffer; contentType: string }>();
  calls: { method: string; path: string; status: number; body?: unknown }[] = [];
  /** Polls of a deployment before it reaches `success`. */
  pollsToFinish = 2;
  /** Make the next deployment fail at this stage (`build` or `deploy`). */
  failNextDeploymentAt: string | null = null;
  /** Polls before a custom domain turns active; `null` = never (stays pending); 'error' = fails. */
  domainBehaviour: number | 'error' | null = 2;
  /** Fail the next N matching calls: `[regexp on "METHOD path", status, body?, headers?]`. */
  failures: { re: RegExp; status: number; body?: Json; retryAfter?: number; times: number }[] = [];
  maxProjects = 100;
  /** Workers Static Assets (cfworkers.ts): scripts of the account, the account's workers.dev subdomain (null = none registered) and the upload sessions. */
  workers = new Map<string, FakeWorker>();
  workersSubdomain: string | null = 'acct-sub';
  maxWorkers = 500;
  /** When false, PUT script uploads a version without deploying it (the documentation does not say which the real API does); the client must then create the deployment. */
  putDeploys = true;
  private sessions = new Map<string, { name: string; manifest: Record<string, { hash: string; size: number }>; done: string | null }>();
  private seq = 0;
  now = () => new Date('2026-03-10T12:00:00.000Z');

  failOn(re: RegExp, status: number, times = 1, extra: { body?: Json; retryAfter?: number } = {}) {
    this.failures.push({ re, status, times, ...extra });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/client\/v4/, '') + (url.search ? url.search : '');
    const reply = (status: number, result?: unknown, errors?: { code: number; message: string }[], headers: Record<string, string> = {}) => {
      this.calls.push({ method, path, status });
      const body = status < 300 ? { success: true, errors: [], messages: [], result } : { success: false, errors: errors ?? [{ code: 1000, message: `HTTP ${status}` }], messages: [], result: null };
      return new Response([204, 304].includes(status) ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    };
    const key = `${method} ${path}`;
    const fail = this.failures.find((f) => f.times > 0 && f.re.test(key));
    if (fail) {
      fail.times--;
      return reply(fail.status, undefined, (fail.body?.errors as { code: number; message: string }[] | undefined) ?? [{ code: fail.status === 429 ? 971 : 10000, message: fail.status === 429 ? 'Rate limited' : 'Injected failure' }], fail.retryAfter ? { 'retry-after': String(fail.retryAfter) } : {});
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const bearer = auth.replace(/^Bearer /, '');
    // upload endpoints take the JWT from upload-token
    const isAsset = path.startsWith('/pages/assets/');
    if (isAsset) {
      if (!/^jwt\.[a-z0-9-]+\.\d+$/.test(bearer)) return reply(401, undefined, [{ code: 8000013, message: 'Invalid upload token' }]);
    } else if (!/^\/accounts\/[^/]+\/workers\/assets\/upload/.test(path) && bearer !== this.token) return reply(401, undefined, [{ code: 10000, message: 'Authentication error' }]);
    const wm = /^\/accounts\/([^/]+)\/workers(\/.*)?$/.exec(path.split('?')[0]!);
    if (wm) return this.workersCall(method, url, wm[1]!, wm[2] ?? '', bearer, init, reply);

    const m = /^\/accounts\/([^/]+)\/pages(\/.*)?$/.exec(path.split('?')[0]!);
    const body = (): unknown => {
      try {
        return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      } catch {
        return null;
      }
    };

    if (isAsset) {
      const p = path.split('?')[0]!;
      if (p === '/pages/assets/check-missing' && method === 'POST') {
        const hashes = (body() as { hashes: string[] }).hashes;
        return reply(200, hashes.filter((h) => !this.assets.has(h)));
      }
      if (p === '/pages/assets/upload' && method === 'POST') {
        if (!this.canWrite) return reply(403, undefined, [{ code: 10000, message: 'Authentication error' }]);
        const items = body() as { key: string; value: string; metadata: { contentType: string }; base64: boolean }[];
        if (!Array.isArray(items)) return reply(400, undefined, [{ code: 8000000, message: 'Expected an array' }]);
        for (const it of items) {
          if (!it.base64 || typeof it.key !== 'string' || typeof it.value !== 'string') return reply(400, undefined, [{ code: 8000000, message: 'Bad upload item' }]);
          this.assets.set(it.key, { bytes: Buffer.from(it.value, 'base64'), contentType: it.metadata?.contentType ?? '' });
        }
        return reply(200, null);
      }
      if (p === '/pages/assets/upsert-hashes' && method === 'POST') return reply(200, null);
      return reply(404);
    }
    if (!m || m[1] !== this.accountId) return reply(m ? 403 : 404, undefined, [{ code: m ? 7003 : 7000, message: m ? 'Account not accessible' : 'No route' }]);
    const rest = m[2] ?? '';
    const readOnly = method === 'GET';
    if (readOnly && !this.canRead && !this.canWrite) return reply(403, undefined, [{ code: 10000, message: 'Authentication error' }]);
    if (!readOnly && !this.canWrite) return reply(403, undefined, [{ code: 10000, message: 'Authentication error' }]);

    if (rest === '/projects' && method === 'GET') {
      // Paged like the real list: ?per_page=&page=, with result_info.total_count.
      if (this.failList) return reply(this.failList.status, undefined, [{ code: this.failList.code, message: this.failList.message }]);
      const per = Math.max(1, Number(url.searchParams.get('per_page') ?? 10));
      if (per > this.maxPerPage) return reply(400, undefined, [{ code: 8000024, message: 'Invalid list options provided. Review the `page` or `per_page` parameter.' }]);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      const all = [...this.projects.values()];
      const result = all.slice((page - 1) * per, page * per).map((p) => this.pjson(p));
      this.calls.push({ method, path, status: 200 });
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { page, per_page: per, count: result.length, total_count: all.length } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (rest === '/projects' && method === 'POST') {
      const b = body() as { name?: string; production_branch?: string } | null;
      if (!b?.name || !/^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/.test(b.name)) return reply(400, undefined, [{ code: 8000011, message: 'Invalid project name' }]);
      if (this.projects.has(b.name)) return reply(409, undefined, [{ code: 8000002, message: 'A project with this name already exists' }]);
      if (this.projects.size >= this.maxProjects) return reply(400, undefined, [{ code: 8000027, message: 'Project limit reached' }]);
      const p: FakeProject = { name: b.name, subdomain: `${b.name}.pages.dev`, domains: new Map(), deployments: [], production: null };
      this.projects.set(b.name, p);
      return reply(200, this.pjson(p));
    }
    const pm = /^\/projects\/([^/]+)(\/.*)?$/.exec(rest);
    if (!pm) return reply(404);
    const project = this.projects.get(decodeURIComponent(pm[1]!));
    const sub = pm[2] ?? '';
    if (!project) return reply(404, undefined, [{ code: 8000007, message: 'Project not found' }]);
    if (sub === '' && method === 'GET') return reply(200, this.pjson(project));
    if (sub === '' && method === 'DELETE') {
      this.projects.delete(project.name);
      return reply(200, null);
    }
    if (sub === '/upload-token' && method === 'GET') return reply(200, { jwt: `jwt.${project.name}.${++this.seq}` });

    if (sub === '/deployments' && method === 'POST') {
      const form = init?.body as FormData | undefined;
      if (!(form instanceof FormData)) return reply(400, undefined, [{ code: 8000000, message: 'multipart/form-data expected' }]);
      let manifest: Record<string, string>;
      try {
        manifest = JSON.parse(String(form.get('manifest') ?? ''));
      } catch {
        return reply(400, undefined, [{ code: 8000096, message: 'manifest is not valid JSON' }]);
      }
      const missing = Object.values(manifest).filter((h) => !this.assets.has(h));
      if (missing.length) return reply(400, undefined, [{ code: 8000096, message: `Missing files: ${missing.slice(0, 3).join(', ')}` }]);
      if (Object.keys(manifest).length > 20_000) return reply(400, undefined, [{ code: 8000011, message: 'Too many files' }]);
      const readFile = async (n: string) => {
        const v = form.get(n);
        return v instanceof Blob ? await v.text() : typeof v === 'string' ? v : '';
      };
      const d: FakeDeployment = { id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`, project: project.name, manifest, headers: await readFile('_headers'), redirects: await readFile('_redirects'), environment: String(form.get('branch') ?? 'main') === 'main' ? 'production' : 'preview', polls: 0, createdOn: this.now().toISOString(), failStage: this.failNextDeploymentAt, promoted: false };
      this.failNextDeploymentAt = null;
      project.deployments.unshift(d);
      return reply(200, this.djson(d, project));
    }
    const dm = /^\/deployments\/([^/]+)(\/rollback)?$/.exec(sub);
    if (dm) {
      const d = project.deployments.find((x) => x.id === decodeURIComponent(dm[1]!));
      if (!d) return reply(404, undefined, [{ code: 8000013, message: 'Deployment not found' }]);
      if (dm[2] && method === 'POST') {
        if (this.state(d) !== 'success') return reply(400, undefined, [{ code: 8000000, message: 'Only a successful deployment can be rolled back to' }]);
        project.production = d.id;
        return reply(200, this.djson(d, project));
      }
      if (!dm[2] && method === 'GET') {
        d.polls++;
        return reply(200, this.djson(d, project));
      }
      if (!dm[2] && method === 'DELETE') {
        if (project.production === d.id && !url.searchParams.get('force')) return reply(400, undefined, [{ code: 8000034, message: 'Cannot delete the active production deployment' }]);
        project.deployments = project.deployments.filter((x) => x !== d);
        if (project.production === d.id) project.production = null;
        return reply(200, null);
      }
    }
    if (sub === '/domains' && method === 'POST') {
      const name = (body() as { name?: string } | null)?.name;
      if (!name || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) return reply(400, undefined, [{ code: 8000018, message: 'Invalid domain' }]);
      if ([...this.projects.values()].some((p) => p.domains.has(name))) return reply(409, undefined, [{ code: 8000018, message: 'Domain already in use' }]);
      project.domains.set(name, { polls: 0 });
      return reply(200, this.domjson(project, name));
    }
    const dom = /^\/domains\/([^/]+)$/.exec(sub);
    if (dom) {
      const name = decodeURIComponent(dom[1]!);
      const entry = project.domains.get(name);
      if (!entry) return reply(404, undefined, [{ code: 8000018, message: 'Domain not found' }]);
      if (method === 'GET') {
        entry.polls++;
        return reply(200, this.domjson(project, name));
      }
      if (method === 'DELETE') {
        project.domains.delete(name);
        return reply(200, null);
      }
    }
    return reply(404);
  };

  // ---- Workers Static Assets ---------------------------------------------------------------------------------------------------------------------------

  addWorker(name: string) {
    this.workers.set(name, { name, versions: [], deployments: [], live: null, workersDev: false });
  }

  private workersCall(method: string, url: URL, account: string, rest: string, bearer: string, init: RequestInit | undefined, reply: (status: number, result?: unknown, errors?: { code: number; message: string }[]) => Response): Response | Promise<Response> {
    if (account !== this.accountId) return reply(403, undefined, [{ code: 7003, message: 'Account not accessible' }]);
    const body = (): any => {
      try {
        return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      } catch {
        return null;
      }
    };
    const readOnly = method === 'GET';
    if (!readOnly && !this.canWrite) return reply(403, undefined, [{ code: 10000, message: 'Authentication error' }]);
    if (rest === '/scripts' && method === 'GET') return reply(200, [...this.workers.values()].map((w) => ({ id: w.name })));
    if (rest === '/subdomain' && method === 'GET') return this.workersSubdomain ? reply(200, { subdomain: this.workersSubdomain }) : reply(404, undefined, [{ code: 10007, message: 'This account has not enabled a workers.dev subdomain' }]);

    if (rest === '/assets/upload' && method === 'POST') {
      const session = [...this.sessions.entries()].find(([jwt]) => jwt === bearer)?.[1];
      if (!session) return reply(401, undefined, [{ code: 8000013, message: 'Invalid upload token' }]);
      const form = init?.body;
      if (!(form instanceof FormData) || url.searchParams.get('base64') !== 'true') return reply(400, undefined, [{ code: 8000000, message: 'multipart/form-data with base64=true expected' }]);
      return (async () => {
        for (const [hash, part] of form.entries()) {
          if (!(part instanceof Blob)) return reply(400, undefined, [{ code: 8000000, message: 'Bad upload part' }]);
          this.assets.set(hash, { bytes: Buffer.from(await part.text(), 'base64'), contentType: part.type });
        }
        const all = Object.values(session.manifest).every((m) => this.assets.has(m.hash));
        if (!all) return reply(202, { jwt: null });
        session.done = `wdone.${session.name}.${++this.seq}`;
        this.sessions.set(session.done, session);
        return reply(201, { jwt: session.done });
      })();
    }

    const sm = /^\/scripts\/([^/]+)(\/.*)?$/.exec(rest);
    if (!sm) return reply(404);
    const name = decodeURIComponent(sm[1]!);
    const sub = sm[2] ?? '';
    let worker = this.workers.get(name);
    if (sub === '/assets-upload-session' && method === 'POST') {
      const manifest = body()?.manifest as Record<string, { hash: string; size: number }> | undefined;
      if (!manifest || typeof manifest !== 'object') return reply(400, undefined, [{ code: 8000000, message: 'manifest expected' }]);
      if (Object.keys(manifest).length > 20_000) return reply(400, undefined, [{ code: 8000011, message: 'Too many files' }]);
      for (const [path, m] of Object.entries(manifest)) if (!path.startsWith('/') || !/^[0-9a-f]{32}$/.test(m?.hash ?? '') || typeof m.size !== 'number') return reply(400, undefined, [{ code: 8000000, message: `Bad manifest entry ${path}` }]);
      const missing = [...new Set(Object.values(manifest).map((m) => m.hash))].filter((h) => !this.assets.has(h));
      const jwt = `wjwt.${name}.${++this.seq}`;
      this.sessions.set(jwt, { name, manifest, done: missing.length === 0 ? jwt : null });
      const buckets: string[][] = [];
      for (let i = 0; i < missing.length; i += 2) buckets.push(missing.slice(i, i + 2));
      return reply(200, { jwt, buckets });
    }
    if (sub === '/settings' && method === 'GET') return worker ? reply(200, { name }) : reply(404, undefined, [{ code: 10007, message: 'This Worker does not exist' }]);
    if (sub === '' && method === 'PUT') {
      const form = init?.body;
      if (!(form instanceof FormData)) return reply(400, undefined, [{ code: 8000000, message: 'multipart/form-data expected' }]);
      const metaPart = form.get('metadata');
      if (!(metaPart instanceof Blob)) return reply(400, undefined, [{ code: 10021, message: 'metadata part missing' }]);
      return (async () => {
        let meta: any;
        try {
          meta = JSON.parse(await metaPart.text());
        } catch {
          return reply(400, undefined, [{ code: 10021, message: 'metadata is not JSON' }]);
        }
        if (!meta.main_module || !(form.get(meta.main_module) instanceof Blob)) return reply(400, undefined, [{ code: 10021, message: 'main_module part missing' }]);
        const session = meta.assets?.jwt ? this.sessions.get(meta.assets.jwt) : undefined;
        if (!session || session.name !== name || session.done !== meta.assets.jwt) return reply(400, undefined, [{ code: 10021, message: 'assets.jwt is not a completion token for this Worker' }]);
        if (!worker) {
          if (this.workers.size >= this.maxWorkers) return reply(400, undefined, [{ code: 10037, message: `You have reached the limit of ${this.maxWorkers} Workers` }]);
          worker = { name, versions: [], deployments: [], live: null, workersDev: false };
          this.workers.set(name, worker);
        }
        const version: FakeVersion = { id: `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`, manifest: Object.fromEntries(Object.entries(session.manifest).map(([k, m]) => [k, m.hash])) };
        worker.versions.push(version);
        if (this.putDeploys) this.deployVersion(worker, version.id);
        return reply(200, { id: name, etag: version.id });
      })();
    }
    if (!worker) return reply(404, undefined, [{ code: 10007, message: 'This Worker does not exist' }]);
    if (sub === '/versions' && method === 'GET') return reply(200, { items: [...worker.versions].reverse().map((v) => ({ id: v.id })) });
    if (sub === '/deployments' && method === 'GET') return reply(200, { deployments: worker.deployments });
    if (sub === '/deployments' && method === 'POST') {
      const b = body();
      const v = b?.versions?.[0];
      if (b?.strategy !== 'percentage' || !v || !worker.versions.some((x) => x.id === v.version_id) || v.percentage !== 100) return reply(400, undefined, [{ code: 10021, message: 'Invalid deployment' }]);
      return reply(200, this.deployVersion(worker, v.version_id));
    }
    if (sub === '/subdomain' && method === 'POST') {
      worker.workersDev = body()?.enabled === true;
      return reply(200, { enabled: worker.workersDev, previews_enabled: false });
    }
    if (sub === '' && method === 'DELETE') {
      this.workers.delete(name);
      return reply(200, null);
    }
    return reply(404);
  }

  private deployVersion(w: FakeWorker, versionId: string): FakeWorkerDeployment {
    const d: FakeWorkerDeployment = { id: `00000000-0000-4000-a000-${String(++this.seq).padStart(12, '0')}`, versions: [{ version_id: versionId, percentage: 100 }], created_on: this.now().toISOString() };
    w.deployments.unshift(d);
    w.live = versionId;
    return d;
  }

  /** What visitors get from `https://<worker>.<subdomain>.workers.dev<path>` (null when the address does not answer: no workers.dev route, or nothing deployed). */
  serveWorker(name: string, path: string): { status: number; body: string; contentType: string } | null {
    const w = this.workers.get(name);
    const v = w?.versions.find((x) => x.id === w.live);
    if (!w || !w.workersDev || !v) return null;
    const read = (file: string) => {
      const h = v.manifest[file];
      const a = h ? this.assets.get(h) : undefined;
      return a && pagesHash(a.bytes, file) === h ? a : null;
    };
    for (const c of path.endsWith('/') ? [`${path}index.html`] : [path, `${path}/index.html`]) {
      const a = read(c);
      if (a) return { status: 200, body: a.bytes.toString('utf8'), contentType: a.contentType };
    }
    const nf = read('/404.html');
    return nf ? { status: 404, body: nf.bytes.toString('utf8'), contentType: nf.contentType } : { status: 404, body: '', contentType: '' };
  }
  /** The `_headers` file of the live version of a Worker (the platform applies it; the fake only stores it). */
  workerHeaders(name: string): string | null {
    const w = this.workers.get(name);
    const v = w?.versions.find((x) => x.id === w.live);
    const h = v?.manifest['/_headers'];
    return h && this.assets.get(h) ? this.assets.get(h)!.bytes.toString('utf8') : null;
  }

  private pjson(p: FakeProject): Json {
    return { name: p.name, subdomain: p.subdomain, domains: [p.subdomain, ...p.domains.keys()], production_branch: 'main', created_on: this.now().toISOString() };
  }
  private state(d: FakeDeployment): 'running' | 'success' | 'failure' {
    if (d.failStage && d.polls >= 1) return 'failure';
    return d.polls >= this.pollsToFinish ? 'success' : 'running';
  }
  private djson(d: FakeDeployment, p: FakeProject): Json {
    const s = this.state(d);
    // A production deployment becomes the live one the first time it is seen finished (a later rollback to an older one is not undone by polling again).
    if (s === 'success' && d.environment === 'production' && !d.promoted) {
      d.promoted = true;
      p.production = d.id;
    }
    const names = ['queued', 'initialize', 'clone_repo', 'build', 'deploy'];
    const failIdx = d.failStage ? names.indexOf(d.failStage) : -1;
    const stages = names.map((name, i) => ({
      name,
      status: s === 'success' ? 'success' : s === 'failure' ? (i < failIdx ? 'success' : i === failIdx ? 'failure' : 'idle') : i < Math.min(d.polls + 1, 4) ? 'success' : i === Math.min(d.polls + 1, 4) ? 'active' : 'idle',
      started_on: null,
      ended_on: null,
    }));
    return {
      id: d.id, short_id: d.id.slice(-8), project_name: p.name, environment: d.environment, url: `https://${d.id.slice(-8)}.${p.subdomain}`, aliases: s === 'success' && p.production === d.id ? [`https://${p.subdomain}`] : null,
      latest_stage: stages[Math.min(Math.max(d.polls, 0) + 1, 4)] ?? stages[4], stages, created_on: d.createdOn, deployment_trigger: { type: 'ad_hoc', metadata: { branch: 'main' } },
    };
  }
  private domjson(p: FakeProject, name: string): Json {
    const e = p.domains.get(name)!;
    const b = this.domainBehaviour;
    const status = b === 'error' ? 'error' : b === null ? 'pending' : e.polls >= b ? 'active' : e.polls === 0 ? 'initializing' : 'pending';
    return {
      id: `dom_${name}`, domain_id: `dom_${name}`, name, status, certificate_authority: 'google',
      validation_data: { method: 'txt', status: status === 'active' ? 'active' : 'pending', ...(status === 'error' ? { error_message: 'CNAME record not set' } : {}) },
      verification_data: { status: status === 'active' ? 'active' : status === 'error' ? 'error' : 'pending', ...(status === 'error' ? { error_message: 'CNAME record not set' } : {}) }, zone_tag: 'z', created_on: this.now().toISOString(),
    };
  }

  // ---- inspection helpers for tests --------------------------------------------------------------------------------------------------------------------

  /** What visitors get from `https://<project>.pages.dev<path>` or one of its custom domains: Pages' rules for index.html, then 404.html. Files whose hash does not match are not served. */
  serve(projectName: string, path: string): { status: number; body: string; contentType: string } | null {
    const p = this.projects.get(projectName);
    const d = p?.deployments.find((x) => x.id === p.production);
    if (!p || !d) return null;
    const read = (file: string) => {
      const h = d.manifest[file];
      const a = h ? this.assets.get(h) : undefined;
      return a && pagesHash(a.bytes, file) === h ? a : null;
    };
    const candidates = path.endsWith('/') ? [`${path}index.html`] : [path, `${path}/index.html`];
    for (const c of candidates) {
      const a = read(c);
      if (a) return { status: 200, body: a.bytes.toString('utf8'), contentType: a.contentType };
    }
    const nf = read('/404.html');
    return nf ? { status: 404, body: nf.bytes.toString('utf8'), contentType: nf.contentType } : { status: 404, body: '', contentType: '' };
  }
  production(projectName: string): FakeDeployment | undefined {
    const p = this.projects.get(projectName);
    return p?.deployments.find((x) => x.id === p.production);
  }
  deployments(projectName: string): FakeDeployment[] {
    return this.projects.get(projectName)?.deployments ?? [];
  }
  callsTo(re: RegExp) {
    return this.calls.filter((c) => re.test(`${c.method} ${c.path}`));
  }
}
