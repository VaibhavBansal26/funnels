import type { Hono } from 'hono';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import type { AiProvider } from '../src/ai/types.js';
import { createApp } from '../src/app.js';
import { createDeps, createWorker } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { testDb } from './support/backend.js';
import type { Deps } from '../src/deps.js';
import type { DnsResolver } from '../src/dns/resolver.js';
import type { HttpClient, HttpPost } from '../src/net/ssrf.js';
import { silentLogger } from '../src/logger.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { type EventInsert, insertEvents } from '../src/services/rollups.js';
import { newId } from '../src/util/ids.js';

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
  register(email?: string, name?: string): Promise<{ token: string; refreshToken: string; wsId: string; userId: string; email: string }>;
  mailer: CaptureMailer;
  /** Invites `email` into the owner's workspace with a built-in role id or a custom role id and accepts the invitation (the real flow, through the captured mail). */
  member(owner: { token: string }, role: string, email?: string): Promise<{ token: string; refreshToken: string; userId: string; email: string }>;
  /** A member whose role is a fresh custom role holding exactly `permissions`. */
  memberWith(owner: { token: string }, permissions: string[], email?: string): Promise<{ token: string; refreshToken: string; userId: string; email: string; roleId: string }>;
}

let counter = 0;

export { BACKEND, IS_PG, testDb, failOn } from './support/backend.js';

export async function makeHarness(opts: { env?: Record<string, string>; ai?: AiProvider; deps?: Partial<Deps> } = {}): Promise<Harness> {
  const clock = new FakeClock();
  const dns = new FakeDns();
  const http = new FakeHttp();
  const lookupTable = new Map<string, string[]>([['hooks.example.com', ['93.184.216.34']]]);
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_PATH: ':memory:', JWT_SECRET: 'test-secret-test-secret-test-secret-123456', TRUST_PROXY: 'true', LOG_LEVEL: 'silent',
    ENABLE_WORKER: 'false', EVENT_BUFFER_MS: '0', IP_GUARD_PER_MINUTE: '10000000', AUTH_ATTEMPTS_PER_MINUTE: '10000000', PUBLIC_PAGES_PER_MINUTE: '10000000', ACCESS_TOKEN_TTL_SECONDS: '31536000', APP_PUBLIC_CNAME_TARGET: 'sites.funnels.test', APP_PUBLIC_URL: 'https://app.funnels.test', WEB_DIST: '/nonexistent', ...opts.env,
  });
  const mailer = new CaptureMailer();
  const deps = await createDeps(config, {
    mailer, db: opts.deps?.db ?? (await testDb()), now: clock.now, log: silentLogger, dns, http, ai: opts.ai ?? new HeuristicProvider(),
    lookup: async (h) => {
      const r = lookupTable.get(h);
      if (!r) throw new Error('ENOTFOUND');
      return r;
    },
    ...opts.deps,
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

  const h: Harness = {
    app, deps, clock, dns, http, lookupTable, worker, call, mailer,
    async register(email = `owner${++counter}@example.test`, name = 'Owner') {
      const r = await call('POST', '/api/auth/register', { body: { email, password: 'correct horse battery', name } });
      if (r.status !== 201) throw new Error(`register failed: ${r.text}`);
      return { token: r.json.token, refreshToken: r.json.refreshToken, wsId: r.json.workspace.id, userId: r.json.user.id, email };
    },
    async member(owner, role, email = `${role}${++counter}@example.test`) {
      const invited = await call('POST', '/api/invitations', { token: owner.token, body: { email, roleId: role } });
      if (invited.status !== 201) throw new Error(`invite failed: ${invited.text}`);
      const link = mailer.linkTo(email);
      if (!link) throw new Error('no invitation mail captured');
      const accepted = await call('POST', '/api/auth/invitations/accept', { body: { token: new URL(link).searchParams.get('token'), name: role, password: 'correct horse battery' } });
      if (accepted.status !== 201) throw new Error(`accept failed: ${accepted.text}`);
      return { token: accepted.json.token, refreshToken: accepted.json.refreshToken, userId: accepted.json.user.id, email };
    },
    async memberWith(owner, permissions, email = `custom${++counter}@example.test`) {
      const role = await call('POST', '/api/roles', { token: owner.token, body: { name: `Role ${++counter} ${Math.random().toString(36).slice(2, 6)}`, permissions } });
      if (role.status !== 201) throw new Error(`role failed: ${role.text}`);
      const m = await h.member(owner, role.json.id, email);
      return { ...m, roleId: role.json.id as string };
    },
  };
  return h;
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
  // Forms and products are the server-derived definitions stored with the version-2 document.
  return type === 'form' ? page.json.doc.forms : type === 'checkout' ? page.json.doc.products : [];
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

/** Inserts raw events through the production write path (so `event_rollups` stays in step), for tests that need exact timestamps. */
export async function seedEvents(h: Harness, rows: (Pick<EventInsert, 'workspace_id' | 'funnel_id' | 'step_id'> & Partial<EventInsert>)[]): Promise<void> {
  let n = 0;
  const full: EventInsert[] = rows.map((r) => ({
    id: newId('evt') + String(++n), type: 'page_view', visitor_id: null, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null,
    created_at: '2026-03-10T12:00:00.000Z', ...r,
  }));
  await h.deps.db.transaction((tx) => insertEvents(tx, full));
}

/**
 * A JWT whose signature is certainly different. NOT the last character: a 32-byte HS256 signature is 43 base64url characters whose last one carries only 4
 * significant bits, so 'A', 'B', 'C' and 'D' there decode to the same bytes and replacing one with another yields a still-valid token (a ~1 in 16 flake).
 */
export function tamperSignature(jwt: string): string {
  const [h, p, sig] = jwt.split('.');
  const i = 10;
  return `${h}.${p}.${sig!.slice(0, i)}${sig![i] === 'A' ? 'B' : 'A'}${sig!.slice(i + 1)}`;
}

/** Text of the first heading of a page document returned by the API (version 2). */
export function headingText(doc: any): string | null {
  const find = (n: any): string | null => {
    if (n && typeof n.tagName === 'string' && /^h[1-6]$/.test(n.tagName)) return textOf(n);
    for (const c of n?.components ?? []) {
      const hit = find(c);
      if (hit !== null) return hit;
    }
    return null;
  };
  return find(doc.project.pages[0].frames[0].component);
}
export function textOf(n: any): string {
  return n.type === 'textnode' ? n.content : (n.components ?? []).map(textOf).join('');
}
