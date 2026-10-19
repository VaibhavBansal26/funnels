import type { Hono } from 'hono';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import type { AiProvider } from '../src/ai/types.js';
import { createApp } from '../src/app.js';
import { createDeps, createWorker } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/db.js';
import type { Deps } from '../src/deps.js';
import type { DnsResolver } from '../src/dns/resolver.js';
import type { HttpClient, HttpPost } from '../src/net/ssrf.js';
import { silentLogger } from '../src/logger.js';

export class FakeClock {
  constructor(public date = new Date('2026-03-10T12:00:00.000Z')) {}
  now = () => new Date(this.date);
  advance(ms: number) {
    this.date = new Date(this.date.getTime() + ms);
  }
  set(iso: string) {
    this.date = new Date(iso);
  }
}

export class FakeDns implements DnsResolver {
  cname = new Map<string, string[]>();
  txt = new Map<string, string[]>();
  fail = false;
  async resolveCname(h: string) {
    if (this.fail) throw new Error('SERVFAIL');
    return this.cname.get(h) ?? [];
  }
  async resolveTxt(h: string) {
    if (this.fail) throw new Error('SERVFAIL');
    return this.txt.get(h) ?? [];
  }
}

export class FakeHttp implements HttpClient {
  calls: HttpPost[] = [];
  statuses: (number | Error)[] = [];
  async post(req: HttpPost) {
    this.calls.push(req);
    const next = this.statuses.length ? this.statuses.shift()! : 200;
    if (next instanceof Error) throw next;
    return { status: next };
  }
}

export interface Res<T = any> {
  status: number;
  json: T;
  headers: Headers;
  text: string;
}

export interface Harness {
  app: Hono;
  deps: Deps;
  clock: FakeClock;
  dns: FakeDns;
  http: FakeHttp;
  lookupTable: Map<string, string[]>;
  worker: ReturnType<typeof createWorker>;
  call(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string }): Promise<Res>;
  register(email?: string, name?: string): Promise<{ token: string; wsId: string; userId: string }>;
  member(owner: { token: string }, role: 'admin' | 'member', email?: string): Promise<{ token: string; userId: string }>;
}

let counter = 0;

export function makeHarness(opts: { env?: Record<string, string>; ai?: AiProvider } = {}): Harness {
  const clock = new FakeClock();
  const dns = new FakeDns();
  const http = new FakeHttp();
  const lookupTable = new Map<string, string[]>([['hooks.example.com', ['93.184.216.34']]]);
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_PATH: ':memory:', JWT_SECRET: 'test-secret-test-secret-test-secret-123456', TRUST_PROXY: 'true', LOG_LEVEL: 'silent',
    ENABLE_WORKER: 'false', ACCESS_TOKEN_TTL_SECONDS: '31536000', APP_PUBLIC_CNAME_TARGET: 'sites.funnels.test', APP_PUBLIC_URL: 'https://app.funnels.test', WEB_DIST: '/nonexistent', ...opts.env,
  });
  const deps = createDeps(config, {
    db: openDb(':memory:'), now: clock.now, log: silentLogger, dns, http, ai: opts.ai ?? new HeuristicProvider(),
    lookup: async (h) => {
      const r = lookupTable.get(h);
      if (!r) throw new Error('ENOTFOUND');
      return r;
    },
  });
  const app = createApp(deps);
  const worker = createWorker(deps);

  const call: Harness['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (Test)', 'x-forwarded-for': '203.0.113.7', ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: string | undefined = o.raw;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await app.request(path, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }
    return { status: res.status, json, headers: res.headers, text };
  };

  return {
    app, deps, clock, dns, http, lookupTable, worker, call,
    async register(email = `owner${++counter}@example.test`, name = 'Owner') {
      const r = await call('POST', '/api/auth/register', { body: { email, password: 'correct horse battery', name } });
      if (r.status !== 201) throw new Error(`register failed: ${r.text}`);
      return { token: r.json.token, wsId: r.json.workspace.id, userId: r.json.user.id };
    },
    async member(owner, role, email = `${role}${++counter}@example.test`) {
      const created = await call('POST', '/api/members', { token: owner.token, body: { email, name: role, role } });
      if (created.status !== 201) throw new Error(`member failed: ${created.text}`);
      const login = await call('POST', '/api/auth/login', { body: { email, password: created.json.temporaryPassword } });
      return { token: login.json.token, userId: login.json.user.id };
    },
  };
}

/** Verified domain ready for funnels: pending -> active through the fake DNS. */
export async function activeDomain(h: Harness, token: string, hostname = 'offers.example.com') {
  const d = await h.call('POST', '/api/domains', { token, body: { hostname } });
  h.dns.cname.set(hostname, ['sites.funnels.test']);
  h.dns.txt.set(`_funnels-challenge.${hostname}`, [d.json.dns.txt.value]);
  const v = await h.call('POST', `/api/domains/${d.json.id}/verify`, { token });
  if (v.json.domain.status !== 'active') throw new Error('domain not active: ' + v.text);
  return d.json.id as string;
}

export async function makeFunnel(h: Harness, token: string, body: Record<string, unknown> = {}) {
  const r = await h.call('POST', '/api/funnels', { token, body: { name: 'My funnel', ...body } });
  if (r.status !== 201) throw new Error(`funnel failed: ${r.text}`);
  return r.json;
}

export async function fromTemplate(h: Harness, token: string, slug: string) {
  const r = await h.call('POST', `/api/templates/${slug}/use`, { token });
  if (r.status !== 201) throw new Error(`template failed: ${r.text}`);
  return r.json;
}

export async function blocksOf(h: Harness, token: string, funnelId: string, stepId: string, type: string): Promise<any[]> {
  const page = await h.call('GET', `/api/funnels/${funnelId}/steps/${stepId}/page`, { token });
  const out: any[] = [];
  const walk = (list: any[]) => {
    for (const b of list) {
      if (b.type === type) out.push(b);
      if (b.children) walk(b.children);
      if (b.columns) b.columns.forEach((c: any) => walk(c.children));
    }
  };
  walk(page.json.doc.blocks);
  return out;
}

/** A funnel with a lead form on step 1. */
export async function formTarget(h: Harness, token: string) {
  const f = await fromTemplate(h, token, 'lead-magnet');
  const step = f.steps[0];
  const [form] = await blocksOf(h, token, f.id, step.id, 'form');
  return { funnelId: f.id as string, stepId: step.id as string, blockId: form.id as string, path: `/api/public/forms/${f.id}/${step.id}/${form.id}`, funnel: f };
}

/** A funnel with main checkout, bump and upsell blocks. */
export async function checkoutTarget(h: Harness, token: string) {
  const f = await fromTemplate(h, token, 'sales-page-bump-upsell');
  const [sales, upsell] = f.steps;
  const co = await blocksOf(h, token, f.id, sales.id, 'checkout');
  const up = await blocksOf(h, token, f.id, upsell.id, 'checkout');
  const main = co.find((b) => !b.orderBump)!;
  const bump = co.find((b) => b.orderBump)!;
  return {
    funnel: f, funnelId: f.id as string, salesStepId: sales.id as string, upsellStepId: upsell.id as string,
    mainPath: `/api/public/checkout/${f.id}/${sales.id}/${main.id}`,
    bumpId: bump.id as string,
    upsellPath: `/api/public/checkout/${f.id}/${upsell.id}/${up[0].id}`,
  };
}
