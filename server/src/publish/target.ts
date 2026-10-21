import { AppError } from '../errors.js';
import type { Bundle } from './bundle.js';
import { batches, CloudflareApiError, CloudflarePagesClient, deploymentState, type PagesCredentials, type PagesDomain } from './cfclient.js';
import { CloudflareWorkersClient } from './cfworkers.js';
import { pagesHash } from './hash.js';

/**
 * Where a funnel's static site is published. Two implementations share one interface so the deployment state machine (services/publishing.ts) does not care:
 *  - `cloudflare-pages`          Pages Direct Upload, one Pages project per funnel, free address `<project>.pages.dev`            (cfclient.ts)
 *  - `cloudflare-workers-assets` Workers Static Assets, one Worker per funnel, free address `<worker>.<account>.workers.dev`   (cfworkers.ts, EXPERIMENTAL)
 * Both are verified against in-memory fakes of the documented APIs only (test/support/fakecf.ts); neither has talked to real Cloudflare.
 */
export type TargetKind = 'cloudflare-pages' | 'cloudflare-workers-assets';
export const TARGET_KINDS: TargetKind[] = ['cloudflare-pages', 'cloudflare-workers-assets'];
/** For SQL: `target IN ${CF_TARGETS_SQL}` */
export const CF_TARGETS_SQL = "('cloudflare-pages', 'cloudflare-workers-assets')";
export const isCloudflareTarget = (t: string | null | undefined): t is TargetKind => t === 'cloudflare-pages' || t === 'cloudflare-workers-assets';

export interface ProjectInfo {
  /** The free address host: `<project>.pages.dev` or `<worker>.<subdomain>.workers.dev` */
  host: string | null;
}

export interface TargetDeployment {
  /** What is stored as the Cloudflare deployment id: Pages deployment id; Workers version id (what a rollback needs). */
  id: string;
  url: string | null;
}

export interface TargetState {
  state: 'running' | 'succeeded' | 'failed';
  message: string | null;
  url?: string | null;
}

export interface PublishTarget {
  readonly kind: TargetKind;
  /** Word for the person: "Cloudflare Pages" */
  readonly label: string;
  /** Name for the unit that is created per funnel: "Pages project" / "Worker" */
  readonly unit: string;
  /** The app refuses to create another unit at this count (the documented limit). */
  readonly unitLimit: number;
  readonly customDomains: boolean;
  verify(): Promise<unknown>;
  countProjects(): Promise<number>;
  getProject(name: string): Promise<ProjectInfo>;
  createProject(name: string): Promise<ProjectInfo>;
  deleteProject(name: string): Promise<void>;
  deploy(project: string, bundle: Bundle, meta: { commitHash: string; message: string }, log?: (m: string) => Promise<void>): Promise<TargetDeployment>;
  getDeployment(project: string, id: string): Promise<TargetState>;
  rollback(project: string, id: string): Promise<void>;
  addDomain(project: string, name: string): Promise<PagesDomain>;
  getDomain(project: string, name: string): Promise<PagesDomain>;
  deleteDomain(project: string, name: string): Promise<void>;
}

export class PagesTarget implements PublishTarget {
  readonly kind = 'cloudflare-pages' as const;
  readonly label = 'Cloudflare Pages';
  readonly unit = 'Pages project';
  readonly unitLimit = 100;
  readonly customDomains = true;
  constructor(readonly client: CloudflarePagesClient) {}
  verify = () => this.client.verify();
  countProjects = () => this.client.countProjects();
  async getProject(name: string): Promise<ProjectInfo> {
    const p = await this.client.getProject(name);
    return { host: p.subdomain || `${name}.pages.dev` };
  }
  async createProject(name: string): Promise<ProjectInfo> {
    const p = await this.client.createProject(name);
    return { host: p.subdomain || `${name}.pages.dev` };
  }
  deleteProject = (name: string) => this.client.deleteProject(name);
  async deploy(project: string, bundle: Bundle, meta: { commitHash: string; message: string }, log?: (m: string) => Promise<void>): Promise<TargetDeployment> {
    const jwt = await this.client.uploadToken(project);
    const hashes = [...new Set(bundle.files.map((f) => f.hash))];
    const missing = new Set(await this.client.checkMissing(jwt, hashes));
    const toSend = bundle.files.filter((f, i, all) => missing.has(f.hash) && all.findIndex((x) => x.hash === f.hash) === i);
    await log?.(`${toSend.length} of ${hashes.length} files are new to Cloudflare`);
    for (const batch of batches(toSend.map((f) => ({ hash: f.hash, base64: Buffer.from(f.bytes).toString('base64'), contentType: f.contentType })))) await this.client.upload(jwt, batch);
    await this.client.upsertHashes(jwt, hashes);
    const cf = await this.client.createDeployment(project, { manifest: bundle.manifest, headers: bundle.headers, redirects: bundle.redirects, commitHash: meta.commitHash, commitMessage: meta.message });
    await log?.(`Cloudflare created deployment ${cf.short_id ?? cf.id}`);
    return { id: cf.id, url: cf.url ?? null };
  }
  async getDeployment(project: string, id: string): Promise<TargetState> {
    const d = await this.client.getDeployment(project, id);
    return { ...deploymentState(d), url: d.url ?? null };
  }
  async rollback(project: string, id: string): Promise<void> {
    await this.client.rollback(project, id);
  }
  addDomain = (p: string, n: string) => this.client.addDomain(p, n);
  getDomain = (p: string, n: string) => this.client.getDomain(p, n);
  deleteDomain = (p: string, n: string) => this.client.deleteDomain(p, n);
}

export class WorkersTarget implements PublishTarget {
  readonly kind = 'cloudflare-workers-assets' as const;
  readonly label = 'Cloudflare Workers (experimental)';
  readonly unit = 'Worker';
  /** 500 is the paid-plan limit; the Free plan allows 100 and Cloudflare's own refusal is mapped to the same message. */
  readonly unitLimit = 500;
  readonly customDomains = false;
  private subdomain: string | null | undefined;
  constructor(readonly client: CloudflareWorkersClient) {}
  verify = () => this.client.verify();
  countProjects = () => this.client.countScripts();
  private async host(name: string): Promise<string> {
    if (this.subdomain === undefined) this.subdomain = await this.client.accountSubdomain();
    if (!this.subdomain) {
      throw new AppError(409, 'WORKERS_SUBDOMAIN_MISSING', 'This Cloudflare account has no workers.dev subdomain yet. Open the Cloudflare dashboard > Workers & Pages, choose a subdomain when it asks (or in Workers & Pages > your Worker > Settings > Domains & Routes), then try again.');
    }
    return `${name}.${this.subdomain}.workers.dev`;
  }
  async getProject(name: string): Promise<ProjectInfo> {
    const host = await this.host(name);
    if (!(await this.client.scriptExists(name))) throw new CloudflareApiError(404, null, 'Worker not found');
    return { host };
  }
  /** A Worker comes into being with its first upload; creating "the project" only checks that the address will exist. */
  async createProject(name: string): Promise<ProjectInfo> {
    return { host: await this.host(name) };
  }
  deleteProject = (name: string) => this.client.deleteScript(name);
  async deploy(project: string, bundle: Bundle, meta: { commitHash: string; message: string }, log?: (m: string) => Promise<void>): Promise<TargetDeployment> {
    const enc = new TextEncoder();
    const files = bundle.files.map((f) => ({ path: f.path, hash: f.hash, size: f.bytes.length, bytes: f.bytes, contentType: f.contentType }));
    // Static assets read `_headers` and `_redirects` from the uploaded files, so they travel in the manifest like any other file.
    const extra = (path: string, text: string) => {
      if (!text) return;
      const bytes = enc.encode(text);
      files.push({ path, hash: pagesHash(bytes, path), size: bytes.length, bytes, contentType: 'text/plain' });
    };
    extra('/_headers', bundle.headers);
    extra('/_redirects', bundle.redirects);
    await log?.(`Uploading ${files.length} files as a Worker with static assets`);
    const d = await this.client.deploy(project, files, meta.message);
    await this.client.enableWorkersDev(project);
    await log?.(`Cloudflare deployed ${d.versionId ?? d.id}`);
    return { id: d.versionId ?? d.id, url: null };
  }
  async getDeployment(project: string, id: string): Promise<TargetState> {
    const d = await this.client.latestDeployment(project);
    if (d && (d.versionId === id || d.id === id)) return { state: 'succeeded', message: null };
    return { state: 'running', message: null };
  }
  async rollback(project: string, id: string): Promise<void> {
    await this.client.rollback(project, id);
  }
  async addDomain(): Promise<PagesDomain> {
    throw new AppError(409, 'CUSTOM_DOMAIN_UNSUPPORTED', 'Custom domains are not supported by the experimental Workers target yet. Use the workers.dev address or publish to Cloudflare Pages.');
  }
  getDomain = this.addDomain;
  async deleteDomain(): Promise<void> {}
}

export function createTarget(kind: TargetKind, creds: PagesCredentials, fetchImpl: typeof fetch): PublishTarget {
  return kind === 'cloudflare-workers-assets' ? new WorkersTarget(new CloudflareWorkersClient(creds, fetchImpl)) : new PagesTarget(new CloudflarePagesClient(creds, fetchImpl));
}
